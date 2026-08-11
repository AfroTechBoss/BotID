/**
 * Deploy and wire the BotID protocol.
 *
 *   npx hardhat run scripts/deploy.js --network <name>
 *
 * The wiring order below is the one exercised by the test suite (test/helpers.js). It matters:
 * ReputationEngine must accept writes from both the registry (agent init) and the router
 * (outcomes and faults), and the registry must know the router before any execution is
 * requested. A deployment that misses one of those calls looks healthy until the first
 * settlement reverts.
 *
 * Configuration is by environment variable; everything has a local-development default except
 * BOND_TOKEN, which must be set on any real network.
 *
 *   OWNER              protocol owner (default: deployer)
 *   TREASURY           receives protocol fees and slash residue (default: deployer)
 *   BOND_TOKEN         ERC-20 agents bond and consumers pay in. On a local chain a MockERC20
 *                      is deployed if this is unset; elsewhere it is required.
 *   BOND_TOKEN_DECIMALS  override, only needed if the token has no decimals()
 *   PUBLISHERS         comma-separated input-feed publisher addresses
 *   PUBLISHER_QUORUM   signatures required per feed reading (default: contract default)
 *   INPUT_MAX_AGE      seconds a feed reading stays fresh, only read alongside the above (300)
 *   TEE_NOTARIES       comma-separated addresses allowed to enroll Silver-tier enclaves
 *   DEPLOY_GOLD        "false" to skip the Gold adapter, its verifier and the model binding
 *   EZKL_VERIFIER      reuse an already-deployed verifier instead of deploying Verifier.sol
 *   MODEL_COMMITMENT   override the model bound to that verifier (default: from circuits/spec.json)
 *   INPUT_SCALE_BITS   override the circuit's input_scale (default: from circuits/spec.json)
 *
 * Capital-denominated parameters, all in WHOLE TOKENS and scaled by the bond token's decimals:
 *
 *   HALF_WEIGHT          notional at which one execution moves the score halfway (100000)
 *   WEIGHT_CAP           cap on a single execution's weight (1000000)
 *   MIN_BOND             minimum bond to register (500)
 *   GLOBAL_NOTIONAL_CAP  protocol-wide open exposure ceiling (5000000)
 *   CHALLENGE_BOND       bond required to challenge a delivery (100)
 */

const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const Tier = { None: 0, Bronze: 1, Silver: 2, Gold: 3 };
const LOCAL_CHAINS = new Set([31337n, 1337n]);

const addressList = (raw) =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => ethers.getAddress(s));

/**
 * Gold-tier proof verification is Groth16 over bn254, which is only affordable if the chain
 * exposes the standard precompiles. `0x08` (pairing check) with empty input is defined to
 * return 1, so a single eth_call tells us whether the Gold tier is deployable here at all.
 * Bronze and Silver do not depend on this.
 */
async function hasBn254Precompiles() {
  try {
    const pairing = await ethers.provider.call({ to: "0x0000000000000000000000000000000000000008", data: "0x" });
    return BigInt(pairing || "0x0") === 1n;
  } catch {
    return false;
  }
}

/**
 * Every capital-denominated default in the contracts is written in 18-decimal units, because
 * that is what `MockERC20` uses and what the tests are built on. Those defaults are storage
 * initialisers, so a deployment against a token with different decimals inherits them silently
 * — and the two worst cases do not announce themselves:
 *
 *   - `halfWeight`/`weightCap` too large by 10^12 makes the EWMA weight one part in a trillion.
 *     Scores never move. Every agent sits at neutral forever and the protocol produces nothing.
 *   - `challengeBondAmount` too large by 10^12 makes challenges unaffordable, which quietly
 *     removes the only thing making Bronze and Silver honest.
 *
 * Neither reverts. So the decimals are read from the token and every such parameter is derived
 * from them here, rather than trusting the deployer to notice.
 */
const CAPITAL_DEFAULTS = {
  HALF_WEIGHT: "100000",
  WEIGHT_CAP: "1000000",
  MIN_BOND: "500",
  GLOBAL_NOTIONAL_CAP: "5000000",
  CHALLENGE_BOND: "100",
};

async function bondTokenDecimals(address) {
  if (process.env.BOND_TOKEN_DECIMALS !== undefined) {
    const d = Number(process.env.BOND_TOKEN_DECIMALS);
    if (!Number.isInteger(d) || d < 0 || d > 36) {
      throw new Error(`BOND_TOKEN_DECIMALS="${process.env.BOND_TOKEN_DECIMALS}" is not a decimals value`);
    }
    return d;
  }
  try {
    const token = new ethers.Contract(
      address,
      ["function decimals() view returns (uint8)"],
      ethers.provider
    );
    return Number(await token.decimals());
  } catch {
    throw new Error(
      `could not read decimals() from BOND_TOKEN ${address}. Set BOND_TOKEN_DECIMALS ` +
        "explicitly — every capital-denominated parameter is derived from it, and assuming 18 " +
        "against a 6-decimal token silently disables both scoring and challenges."
    );
  }
}

/** A whole-token amount from the environment, scaled to the bond token's decimals. */
function capital(key, decimals) {
  const raw = process.env[key] ?? CAPITAL_DEFAULTS[key];
  try {
    return ethers.parseUnits(raw, decimals);
  } catch {
    throw new Error(`${key}="${raw}" is not a valid whole-token amount`);
  }
}

/**
 * The model a freshly deployed verifier is bound to, read from the circuit's own spec rather
 * than restated here.
 *
 * Both values are part of the model's identity and neither fails loudly when wrong:
 *
 *   - `modelCommitment` is keccak256 of the model name, and it is what an agent registers with.
 *     Bind the verifier under a different commitment and `modelFor[ctx.modelCommitment]` is the
 *     zero Model, so `verify` returns false for every proof — the agent looks dishonest.
 *   - `inputScaleBits` is the circuit's `input_scale`. The public input cells hold
 *     `value << inputScaleBits`, so a wrong shift makes the adapter recompute different
 *     instances than the prover committed to, and every honest proof fails closed.
 *
 * spec.json states both, names itself the source of the commitment convention, and sits beside
 * the circuit that produced the verifying key. Reading it is what keeps the three in step; the
 * alternative is a constant in this file that nothing checks against the circuit.
 */
function referenceModel() {
  const specPath = path.join(__dirname, "..", "..", "circuits", "spec.json");
  if (!fs.existsSync(specPath)) {
    throw new Error(
      `circuits/spec.json not found at ${specPath}. It carries the model name and input scale ` +
        "the verifier must be bound under. Set MODEL_COMMITMENT and INPUT_SCALE_BITS explicitly, " +
        "or DEPLOY_GOLD=false to ship Bronze and Silver only."
    );
  }
  const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));

  const commitment = process.env.MODEL_COMMITMENT ?? ethers.id(spec.name);
  if (!/^0x[0-9a-fA-F]{64}$/.test(commitment)) {
    throw new Error(`MODEL_COMMITMENT="${commitment}" is not a bytes32`);
  }

  const bits = Number(process.env.INPUT_SCALE_BITS ?? spec.inputScaleBits);
  if (!Number.isInteger(bits) || bits < 0 || bits > 64) {
    throw new Error(`input scale bits "${bits}" is not a plausible scale`);
  }

  return { name: spec.name, commitment, inputScaleBits: bits };
}

async function deploy(name, ...args) {
  const factory = await ethers.getContractFactory(name);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  console.log(`  ${name.padEnd(18)} ${await contract.getAddress()}`);
  return contract;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const local = LOCAL_CHAINS.has(chainId);

  const owner = process.env.OWNER ? ethers.getAddress(process.env.OWNER) : deployer.address;
  const treasury = process.env.TREASURY ? ethers.getAddress(process.env.TREASURY) : deployer.address;

  console.log(`\nBotID deployment — ${network.name} (chainId ${chainId})`);
  console.log(`  deployer           ${deployer.address}`);
  console.log(`  owner              ${owner}`);
  console.log(`  treasury           ${treasury}\n`);

  // ------------------------------------------------------------------ bond token
  let bondToken;
  if (process.env.BOND_TOKEN) {
    bondToken = ethers.getAddress(process.env.BOND_TOKEN);
    if ((await ethers.provider.getCode(bondToken)) === "0x") {
      throw new Error(`BOND_TOKEN ${bondToken} has no code on chain ${chainId}`);
    }
    console.log(`  bondToken (given)  ${bondToken}`);
  } else if (local) {
    bondToken = await (await deploy("MockERC20")).getAddress();
  } else {
    throw new Error("BOND_TOKEN must be set on a non-local network");
  }

  const decimals = await bondTokenDecimals(bondToken);
  const halfWeight = capital("HALF_WEIGHT", decimals);
  const weightCap = capital("WEIGHT_CAP", decimals);
  const minBond = capital("MIN_BOND", decimals);
  const globalNotionalCap = capital("GLOBAL_NOTIONAL_CAP", decimals);
  const challengeBond = capital("CHALLENGE_BOND", decimals);
  const whole = (v) => ethers.formatUnits(v, decimals);
  console.log(`  bondToken decimals ${decimals}`);

  // ------------------------------------------------------------------ core
  const engine = await deploy("ReputationEngine", owner);
  const registry = await deploy(
    "AgentRegistry",
    owner,
    bondToken,
    await engine.getAddress(),
    treasury
  );
  const attestor = await deploy("InputAttestor", owner);
  const router = await deploy(
    "ExecutionRouter",
    owner,
    await registry.getAddress(),
    await engine.getAddress(),
    bondToken,
    await attestor.getAddress(),
    treasury
  );

  // ------------------------------------------------------------------ adapters
  const sigAdapter = await deploy("SignatureAdapter");
  const teeAdapter = await deploy("TeeAdapter", owner);

  const goldRequested = process.env.DEPLOY_GOLD !== "false";
  const bn254 = await hasBn254Precompiles();
  let zkAdapter = null;
  let model = null;
  let ezklVerifier = null;
  if (goldRequested && bn254) {
    // The adapter re-derives input commitments through the attestor, so it must be pointed at
    // the same one the router uses. A mismatch fails every honest Gold proof closed.
    zkAdapter = await deploy("ZkAdapter", owner, await attestor.getAddress());

    // An adapter with no verifier registered for a model returns false for every proof against
    // it, and returning false is indistinguishable from a bad proof. So a deployment that stops
    // at the adapter reports success and leaves Gold inert: escalated challenges cannot be
    // answered, every challenged agent is slashed, and the tier that makes Bronze and Silver
    // honest is a name in the manifest. The verifier and the binding are part of deploying Gold,
    // not a follow-up step.
    model = referenceModel();
    if (process.env.EZKL_VERIFIER) {
      ezklVerifier = ethers.getAddress(process.env.EZKL_VERIFIER);
      if ((await ethers.provider.getCode(ezklVerifier)) === "0x") {
        throw new Error(`EZKL_VERIFIER ${ezklVerifier} has no code on chain ${chainId}`);
      }
      console.log(`  ezklVerifier (given) ${ezklVerifier}`);
    } else {
      // Compiled from circuits/build/Verifier.sol, which hardhat.config.js copies into the
      // sources tree on every command — so this is the verifying key the circuit currently has,
      // not one checked in months ago.
      try {
        ezklVerifier = await (await deploy("Halo2Verifier")).getAddress();
      } catch (e) {
        throw new Error(
          "could not deploy Halo2Verifier. It is generated by the circuit build " +
            "(circuits/build/Verifier.sol); regenerate it, pass EZKL_VERIFIER to reuse a " +
            `deployed one, or set DEPLOY_GOLD=false to ship Bronze and Silver only.\n  ${e.message}`
        );
      }
    }
  } else if (goldRequested) {
    console.log("\n  ! bn254 pairing precompile absent — skipping the Gold adapter.");
    console.log("    Bronze and Silver are unaffected, but challenge escalation has no");
    console.log("    court of last resort until a Gold adapter exists on this chain.\n");
  }

  // ------------------------------------------------------------------ wiring
  //
  // Everything below is owner-only. When OWNER is a multisig these calls will revert and must
  // be executed from it instead; the manifest records exactly which ones are outstanding.
  const wiring = [
    ["engine.setWriter(registry)", () => engine.setWriter(registry.getAddress(), true)],
    ["engine.setWriter(router)", () => engine.setWriter(router.getAddress(), true)],
    ["registry.setRouter(router)", () => registry.setRouter(router.getAddress())],
    ["router.setAdapter(Bronze)", () => router.setAdapter(Tier.Bronze, sigAdapter.getAddress())],
    ["router.setAdapter(Silver)", () => router.setAdapter(Tier.Silver, teeAdapter.getAddress())],
  ];
  if (zkAdapter) {
    wiring.push(["router.setAdapter(Gold)", () => router.setAdapter(Tier.Gold, zkAdapter.getAddress())]);
    wiring.push([
      `zkAdapter.setVerifier(${model.name}, scale ${model.inputScaleBits})`,
      () => zkAdapter.setVerifier(model.commitment, ezklVerifier, model.inputScaleBits),
    ]);
  }

  // Capital-denominated parameters. Both setters are all-or-nothing, so the fields that carry no
  // magnitude are read back off the contract and re-passed unchanged — duplicating their defaults
  // here would put a second copy of them in a file that has no way to notice when they drift.
  const [decayHalfLife, livenessHaircutBps, verificationHaircutBps] = await Promise.all([
    engine.decayHalfLife(),
    engine.livenessHaircutBps(),
    engine.verificationHaircutBps(),
  ]);
  const [
    challengeWindow,
    escalationWindow,
    settlementWindow,
    faultSlashBps,
    livenessSlashBps,
    challengerBountyBps,
    protocolFeeBps,
  ] = await Promise.all([
    router.challengeWindow(),
    router.escalationWindow(),
    router.settlementWindow(),
    router.faultSlashBps(),
    router.livenessSlashBps(),
    router.challengerBountyBps(),
    router.protocolFeeBps(),
  ]);

  const [onChainHalfWeight, onChainWeightCap, onChainMinBond, onChainCap, onChainChallengeBond] =
    await Promise.all([
      engine.halfWeight(),
      engine.weightCap(),
      registry.minBond(),
      registry.globalNotionalCap(),
      router.challengeBondAmount(),
    ]);

  if (onChainHalfWeight !== halfWeight || onChainWeightCap !== weightCap) {
    wiring.push([
      `engine.setParameters(halfWeight ${whole(halfWeight)}, weightCap ${whole(weightCap)})`,
      () =>
        engine.setParameters(
          halfWeight,
          weightCap,
          decayHalfLife,
          livenessHaircutBps,
          verificationHaircutBps
        ),
    ]);
  }
  if (onChainMinBond !== minBond || onChainCap !== globalNotionalCap) {
    wiring.push([
      `registry.setLimits(minBond ${whole(minBond)}, cap ${whole(globalNotionalCap)})`,
      () => registry.setLimits(minBond, globalNotionalCap),
    ]);
  }
  if (onChainChallengeBond !== challengeBond) {
    wiring.push([
      `router.setParameters(challengeBond ${whole(challengeBond)})`,
      () =>
        router.setParameters(
          challengeWindow,
          escalationWindow,
          settlementWindow,
          challengeBond,
          faultSlashBps,
          livenessSlashBps,
          challengerBountyBps,
          protocolFeeBps
        ),
    ]);
  }
  for (const p of addressList(process.env.PUBLISHERS)) {
    wiring.push([`attestor.setPublisher(${p})`, () => attestor.setPublisher(p, true)]);
  }
  if (process.env.PUBLISHER_QUORUM) {
    const q = Number(process.env.PUBLISHER_QUORUM);
    const maxAge = Number(process.env.INPUT_MAX_AGE ?? 300);
    wiring.push([`attestor.setQuorum(${q}, ${maxAge}s)`, () => attestor.setQuorum(q, maxAge)]);
  }
  for (const n of addressList(process.env.TEE_NOTARIES)) {
    wiring.push([`teeAdapter.setNotary(${n})`, () => teeAdapter.setNotary(n, true)]);
  }

  console.log("\nwiring");
  const pending = [];
  for (const [label, call] of wiring) {
    if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
      pending.push(label);
      console.log(`  ~ ${label} (deferred — owner is not the deployer)`);
      continue;
    }
    await (await call()).wait();
    console.log(`  + ${label}`);
  }

  // ------------------------------------------------------------------ manifest
  const manifest = {
    network: network.name,
    chainId: Number(chainId),
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    owner,
    treasury,
    bn254Precompiles: bn254,
    bondTokenDecimals: decimals,
    // Recorded in raw units so the values can be checked against the chain without re-deriving
    // them, and so a deferred owner has the exact arguments to execute.
    parameters: {
      halfWeight: halfWeight.toString(),
      weightCap: weightCap.toString(),
      minBond: minBond.toString(),
      globalNotionalCap: globalNotionalCap.toString(),
      challengeBondAmount: challengeBond.toString(),
    },
    contracts: {
      bondToken,
      ReputationEngine: await engine.getAddress(),
      AgentRegistry: await registry.getAddress(),
      InputAttestor: await attestor.getAddress(),
      ExecutionRouter: await router.getAddress(),
      SignatureAdapter: await sigAdapter.getAddress(),
      TeeAdapter: await teeAdapter.getAddress(),
      ZkAdapter: zkAdapter ? await zkAdapter.getAddress() : null,
      Halo2Verifier: ezklVerifier,
    },
    // Recorded so the binding can be checked against the chain without re-deriving it from the
    // circuit, and so a deferred owner has the exact setVerifier arguments. `null` here and a
    // non-null ZkAdapter above would mean Gold is deployed but inert.
    goldModel: model
      ? {
          name: model.name,
          commitment: model.commitment,
          inputScaleBits: model.inputScaleBits,
          verifier: ezklVerifier,
        }
      : null,
    pendingOwnerCalls: pending,
  };

  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${network.name}-${chainId}.json`);
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");

  console.log(`\nmanifest -> ${path.relative(process.cwd(), file)}`);
  if (pending.length) {
    console.log(
      `\n! ${pending.length} owner-only call(s) still outstanding. The protocol is NOT usable ` +
        `until they are executed from ${owner}.`
    );
    if (decimals !== 18) {
      console.log(
        `  ! The bond token has ${decimals} decimals, so the contracts are currently carrying ` +
          "their 18-decimal defaults.\n" +
          "    Until the parameter calls above are executed, scores will not move and no one " +
          "can afford to challenge.\n" +
          "    Neither failure reverts. The exact arguments are in the manifest."
      );
    }
  }
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

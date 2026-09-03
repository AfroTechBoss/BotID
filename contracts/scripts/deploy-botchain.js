/**
 * Deploy the set to BotChain mainnet (chain 677) with the launch configuration recorded in
 * docs/mainnet-checklist.md §2, and refuse to start if the chain does not look like the one those
 * numbers were chosen for.
 *
 * This exists rather than a filled-in .env because of how hardhat.config.js reads configuration:
 * a real environment variable wins over the file. So the mainnet values can be passed for one run
 * without ever being written down, and contracts/.env keeps describing Bohr. That matters more
 * than it sounds. BOND_TOKEN is the one value the checklist calls the most dangerous in the
 * environment: the mainnet USDT address resolves on Bohr to WES, an unrelated live 18-decimal
 * token. A deploy pointed there reads 18 instead of 6, scales every capital parameter by a
 * trillion, reverts nothing, and writes a manifest that looks correct. Leaving the mainnet address
 * sitting in a shared .env is how that happens on the next `--network bohr` run, weeks later, to
 * someone who never read this file.
 *
 * The private key is not here and must not be. It stays in contracts/.env, which is gitignored.
 *
 *   node scripts/deploy-botchain.js          preflight and print, deploy nothing
 *   node scripts/deploy-botchain.js --yes    preflight, then deploy
 *
 * The dry run is the default because this is the irreversible one. registry, engine and bondToken
 * are immutable, so there is no editing a mainnet set afterwards — a mistake is a new address set
 * and a migration, not a fix. Read the printed table against §2 before adding --yes.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const RPC_URL = process.env.BOTCHAIN_RPC_URL ?? "https://rpc.botchain.ai";
const CHAIN_ID = 677n;

/**
 * The launch configuration. Every value is set explicitly, including the ones whose default would
 * have been the same, so the manifest records a decision rather than an accident — §2's rule for
 * OWNER and TREASURY, applied to the rest because the distinction is invisible afterwards.
 */
const CONFIG = Object.freeze({
  // The deployer keeps ownership for now. §3 argues for a multisig and it is still the right
  // answer; what it costs is that every wiring call in §4 reverts during the deploy and has to be
  // replayed from the multisig, leaving the protocol visibly half-built in between. Moving to one
  // later is a single transferOwnership rather than a redeploy, which is why this is deferrable
  // in a way that TREASURY and BOND_TOKEN are not.
  OWNER: "0x08c8108383b69052C04B898676a08Bbbb9ca69F4",

  // Fees and slash residue. setTreasury is behind the 21-day timelock once bootstrap is
  // finalized, so a treasury whose key is not held is not a typo, it is a three-week outage with
  // the protocol's income arriving somewhere unreachable. This address has never transacted on
  // 677 — nonce 0, zero balance — which is normal for a treasury and also means the chain cannot
  // confirm anyone holds it. That confirmation is the operator's, not this script's.
  TREASURY: "0x27F2b72256bAAFF93dCfD50addBFd63F45e2e091",

  // USDT on 677, six decimals. Checked against the chain below rather than trusted from here.
  BOND_TOKEN: "0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C",

  // Capital parameters, in whole tokens. The testnet defaults (100 / 5000000 / 50) were sized so a
  // faucet could fund a demonstration. These are sized for a launch where nothing has settled on a
  // live chain yet: a bond large enough that registering is a decision, a notional cap that bounds
  // total exposure to something the protocol could survive being wrong about, and a challenge bond
  // that costs a griefer without pricing out the watchtowers the protocol depends on.
  //
  // Unlike the three addresses above, none of these are expensive to revise: setLimits and
  // setParameters are plain onlyOwner with no _consume guard, so they take effect immediately even
  // after finalizeBootstrap. The one-way part is MIN_BOND in a different sense — raising it later
  // strands agents who registered under the old floor.
  MIN_BOND: "500",
  CHALLENGE_BOND: "100",
  GLOBAL_NOTIONAL_CAP: "50000",

  // Scoring curve. Unchanged from the defaults the test suite and Bohr both exercise; there is no
  // mainnet-specific reason to move them and moving them would invalidate what Bohr has shown.
  HALF_WEIGHT: "1000",
  WEIGHT_CAP: "10000",

  // Penalty for withdrawing a bond before the unbonding period. The default, set explicitly.
  EARLY_EXIT_PENALTY_BPS: "1000",

  // No Gold. §2's argument: Gold binds one circuit commitment at one input scale, that binding is
  // the part most likely to need revising, and adding a tier later is easier than correcting a
  // tier bound to the wrong verifier. It is not free — setAdapter is timelocked after §4, so
  // adding Gold later is a 21-day round trip rather than a transaction.
  DEPLOY_GOLD: "false",

  // Explicitly empty, not absent. This is a correction, and the 2026-09-03 deploy is what taught
  // it: leaving these out of CONFIG does not produce an empty set, it produces whatever
  // contracts/.env says, because the child still reads that file for everything CONFIG does not
  // override. Bohr's publisher came through exactly that gap and is live on 677.
  //
  // The rule the rest of this object follows — set it even when the value matches the default —
  // has to extend to the values whose intended setting is "nothing", because absent and empty are
  // the same in a JS object and opposite on a chain. On mainnet inert is the better failure: an
  // empty notary set means nobody can enroll an enclave, a wrong one means someone unintended can.
  PUBLISHERS: "",
  PUBLISHER_QUORUM: "",
  TEE_NOTARIES: "",
});

async function preflight() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);

  const net = await provider.getNetwork();
  if (net.chainId !== CHAIN_ID) {
    throw new Error(
      `${RPC_URL} is chain ${net.chainId}, not ${CHAIN_ID} — these parameters are not for it`
    );
  }

  // The check the checklist is really about. Wrong-token is the failure mode that produces a
  // successful deploy, so it has to be caught before the deploy rather than found in the manifest.
  if ((await provider.getCode(CONFIG.BOND_TOKEN)) === "0x") {
    throw new Error(`BOND_TOKEN ${CONFIG.BOND_TOKEN} has no code on chain ${net.chainId}`);
  }
  const token = new ethers.Contract(
    CONFIG.BOND_TOKEN,
    ["function symbol() view returns (string)", "function decimals() view returns (uint8)"],
    provider
  );
  const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()]);
  if (symbol !== "USDT" || Number(decimals) !== 6) {
    throw new Error(
      `BOND_TOKEN ${CONFIG.BOND_TOKEN} answers ${symbol}/${decimals} decimals, expected USDT/6. ` +
        `This is the cross-wired-token case — stop and check the address against the chain.`
    );
  }

  const [owner, block, fee] = await Promise.all([
    provider.getBalance(CONFIG.OWNER),
    provider.getBlockNumber(),
    provider.getFeeData(),
  ]);

  return { symbol, decimals: Number(decimals), owner, block, gasPrice: fee.gasPrice };
}

async function main() {
  const go = process.argv.includes("--yes");

  // deploy.js overwrites deployments/botchain-677.json in place with no confirmation, and on
  // mainnet that file is the only record of which addresses are live. A second --yes would not
  // fail — it would deploy a whole second set and quietly replace the record of the first, which
  // stays deployed, funded and bonded with nothing pointing at it. Once one exists, deploying
  // another has to be typed out.
  const manifest = path.join(__dirname, "..", "deployments", "botchain-677.json");
  if (go && fs.existsSync(manifest) && !process.argv.includes("--redeploy")) {
    throw new Error(
      `${manifest} already exists — chain 677 has a deployed set.\n` +
        `Deploying again abandons it and overwrites the only record of its addresses. ` +
        `If that is really the intent, commit the current manifest first and pass --redeploy.`
    );
  }

  const facts = await preflight();

  console.log(`rpc          ${RPC_URL} — chain ${CHAIN_ID}, block ${facts.block}`);
  console.log(`gas price    ${ethers.formatUnits(facts.gasPrice ?? 0n, "gwei")} gwei`);
  console.log(`bond token   ${CONFIG.BOND_TOKEN} — ${facts.symbol}, ${facts.decimals} decimals`);
  console.log(`owner        ${CONFIG.OWNER} — ${ethers.formatEther(facts.owner)} native held`);
  console.log(`treasury     ${CONFIG.TREASURY}`);
  console.log(`gold         ${CONFIG.DEPLOY_GOLD === "false" ? "not deployed" : "deployed"}`);
  console.log(
    `capital      minBond ${CONFIG.MIN_BOND}, challengeBond ${CONFIG.CHALLENGE_BOND}, ` +
      `notionalCap ${CONFIG.GLOBAL_NOTIONAL_CAP} ${facts.symbol}`
  );
  console.log(
    `curve        halfWeight ${CONFIG.HALF_WEIGHT}, weightCap ${CONFIG.WEIGHT_CAP}, ` +
      `earlyExit ${CONFIG.EARLY_EXIT_PENALTY_BPS} bps`
  );

  if (!go) {
    console.log(`\nPreflight only. Nothing was deployed. Re-run with --yes to deploy.`);
    return;
  }

  console.log(`\ndeploying to BotChain mainnet...\n`);

  // Passed as environment rather than written to a file, so this configuration exists for the
  // lifetime of one child process. hardhat.config.js prefers real environment variables over
  // contracts/.env, which is what makes that work — and PRIVATE_KEY, which is not here, still
  // comes from the file.
  // npx.cmd rather than shell:true. With a shell the arguments are concatenated rather than
  // escaped, which node warns about (DEP0190) and which would matter the moment any value here
  // contained a space.
  const child = spawn(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["hardhat", "run", "scripts/deploy.js", "--network", "botchain"],
    {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, ...CONFIG },
      stdio: "inherit",
    }
  );
  child.on("exit", (code) => {
    if (code === 0) {
      console.log(`\nDeployed. The contracts exist and do nothing yet — §4 of the checklist is the`);
      console.log(`wiring, and finalizeBootstrap must be last and is one-way.`);
    }
    process.exitCode = code ?? 1;
  });
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exitCode = 1;
});

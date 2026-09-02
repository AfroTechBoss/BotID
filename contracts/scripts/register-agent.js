/**
 * Register one agent against a deployed set, and hand its operator key to the relayer.
 *
 * seed.js does this too, but it is hard-gated to chainId 31337/1337 and deliberately so: it
 * mints without limit and prints private keys to stdout. Neither is acceptable against a chain
 * anyone else can read, and the first is not even available — BOND_TOKEN on a real network is
 * a token someone else issued. This script is the same cast of one character, done carefully:
 *
 *   - the operator key is generated here and written straight into the gitignored relayer/.env.
 *     It is never printed, never logged, and never returned. The operator address is printed,
 *     because it is public the moment the registration lands and the caller needs it to send gas.
 *   - the bond is minBond read off the chain, not a literal, because setLimits can move it and a
 *     script that hardcodes 500e18 fails confusingly on a six-decimal token.
 *   - the model commitment is the one in the manifest, so the agent is bound to the circuit the
 *     ZkAdapter already has a verifier for. Registering under any other commitment produces an
 *     agent that canEscalate() answers false for — unchallengeable, which is a real state the
 *     protocol supports but a strange one to choose on purpose.
 *
 *   npx hardhat run scripts/register-agent.js --network bohr
 *
 * Re-running is safe in the sense that it will not double-register: registerAgent reverts with
 * OperatorInUse against an operator that already has an agent, and every operator here is new.
 * It is not idempotent — a second run makes a second agent with a second bond.
 */

const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const Tier = { None: 0, Bronze: 1, Silver: 2, Gold: 3 };

// What the agent declares it can produce, and how much loss it will absorb before a delivery
// counts as a breach. Both match seed.js so an agent registered here behaves like the one the
// local suite exercises. The tier claim is free and cosmetic — credit follows demonstratedTier,
// which only the router raises — so declaring Bronze costs nothing and overclaiming buys nothing.
const TIER = Tier.Bronze;
const LOSS_TOLERANCE_BPS = 500;

/**
 * Rewrite KEY=value lines in place, leaving every other line — comments, blanks, unrelated
 * settings the user put there — exactly as they were. Appends a key that is absent rather than
 * assuming the template shape, because the file is hand-edited and DATABASE_URL may well be the
 * only thing in it that matters to whoever is reading it next.
 */
function updateEnv(file, updates) {
  const original = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.split(/\r?\n/);
  const remaining = new Map(Object.entries(updates));

  const rewritten = lines.map((line) => {
    const m = /^(\s*)([A-Z0-9_]+)\s*=/.exec(line);
    if (!m || !remaining.has(m[2])) return line;
    const key = m[2];
    const value = remaining.get(key);
    remaining.delete(key);
    return `${m[1]}${key}=${value}`;
  });

  for (const [key, value] of remaining) rewritten.push(`${key}=${value}`);
  fs.writeFileSync(file, rewritten.join(eol), { mode: 0o600 });
}

async function main() {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const file = path.join(__dirname, "..", "deployments", `${network.name}-${chainId}.json`);
  if (!fs.existsSync(file)) throw new Error(`no manifest at ${file} — run scripts/deploy.js first`);
  const m = JSON.parse(fs.readFileSync(file, "utf8"));

  const [owner] = await ethers.getSigners();
  if (!owner) throw new Error("no signer — PRIVATE_KEY is not set for this network");

  const registry = await ethers.getContractAt("AgentRegistry", m.contracts.AgentRegistry);
  // A literal ABI rather than MockERC20: the real bond token is not that contract, and attaching
  // its artifact would offer a mint() that is not there to call. Four methods is all this needs.
  const token = new ethers.Contract(
    m.contracts.bondToken,
    [
      "function decimals() view returns (uint8)",
      "function symbol() view returns (string)",
      "function balanceOf(address) view returns (uint256)",
      "function approve(address,uint256) returns (bool)",
    ],
    owner
  );

  const [minBond, decimals, symbol] = await Promise.all([
    registry.minBond(),
    token.decimals(),
    token.symbol(),
  ]);
  const bond = minBond;
  const human = `${ethers.formatUnits(bond, decimals)} ${symbol}`;

  const modelCommitment = m.goldModel?.commitment;
  if (!modelCommitment) throw new Error("manifest has no goldModel.commitment");

  console.log(`registry     ${await registry.getAddress()}`);
  console.log(`bond token   ${await token.getAddress()} (${decimals} decimals)`);
  console.log(`minBond      ${bond} — ${human}`);
  console.log(`commitment   ${modelCommitment}`);
  console.log(`owner        ${owner.address}`);

  // A fresh operator. This is the only place the key exists in plaintext, and it leaves this
  // process only by being written to relayer/.env below.
  const operator = ethers.Wallet.createRandom();
  console.log(`operator     ${operator.address} (new key -> relayer/.env, not printed)`);

  // No minting. deploy.js only falls back to MockERC20 on a local chain; on anything real
  // BOND_TOKEN names a token someone else issued — on Bohr that is a Tether USD contract whose
  // mint() is access-controlled. The bond is moved, not conjured, so an owner short of it has to
  // be told that rather than sent into a revert with a selector in it.
  const held = await token.balanceOf(owner.address);
  if (held < bond) {
    throw new Error(
      `owner holds ${ethers.formatUnits(held, decimals)} ${symbol}, needs ${human} for the bond`
    );
  }
  console.log(`balance      ${ethers.formatUnits(held, decimals)} ${symbol} held, ${human} will be posted`);

  // Exactly the bond, not MaxUint256. The registry pulls once and never again; a standing
  // unlimited allowance to a contract that does not need one is a habit worth not forming.
  await (await token.approve(await registry.getAddress(), bond)).wait();

  const tx = await registry.registerAgent(
    operator.address,
    modelCommitment,
    TIER,
    LOSS_TOLERANCE_BPS,
    bond
  );
  const receipt = await tx.wait();
  const agentId = await registry.agentIdByOperator(operator.address);
  console.log(`\nregistered   agentId ${agentId} in block ${receipt.blockNumber} (tx ${tx.hash})`);

  // Read it back off the chain rather than trusting the arguments we just sent.
  const profile = await registry.getProfile(agentId);
  const units = (v) => `${ethers.formatUnits(v, decimals)} ${symbol}`;
  console.log(`readback     bond ${units(profile.bond)}, credit line ${units(profile.maxOpenNotional)}`);
  console.log(`             score ${profile.score}, active ${profile.active}, tier ${profile.tier}`);
  console.log(`escalatable  ${await (await ethers.getContractAt("ExecutionRouter", m.contracts.ExecutionRouter)).canEscalate(agentId)}`);

  // The bond is posted and the operator is bound to the agent whether or not this write lands.
  // Losing the key here means an agent that nobody can sign for and a bond behind a seven-day
  // unbonding period, so a failure falls back to a file beside it rather than to the exception:
  // relayer/.env can be unwritable for ordinary reasons — open in an editor, wrong permissions —
  // and none of them are worth stranding the registration over. The fallback is written with the
  // same 0600 and sits in the same gitignored directory.
  const envFile = path.join(__dirname, "..", "..", "relayer", ".env");
  const updates = { AGENT_ID: agentId.toString(), OPERATOR_KEY: operator.privateKey };
  try {
    updateEnv(envFile, updates);
    console.log(`wrote        AGENT_ID and OPERATOR_KEY to ${envFile}`);
  } catch (e) {
    const fallback = path.join(path.dirname(envFile), `.env.agent-${agentId}`);
    // Deliberately not `throw e` and not logging e: whatever went wrong, the key must land
    // somewhere before this process exits, and the reason matters less than that.
    fs.writeFileSync(
      fallback,
      Object.entries(updates)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n") + "\n",
      { mode: 0o600 }
    );
    console.log(`\ncould not write ${envFile} (${e.code ?? "write failed"}).`);
    console.log(`wrote        AGENT_ID and OPERATOR_KEY to ${fallback} instead — move them across.`);
  }

  console.log(`\nThe operator holds no gas. Fund ${operator.address} before running the relayer.`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

/**
 * Local-development seed. Reads the manifest written by deploy.js, then sets up the minimum
 * cast of characters needed to drive a full execution lifecycle:
 *
 *   - a feed publisher whose key the reference relayer and consumer both hold
 *   - a Bronze agent, bonded, with a known operator key
 *   - a mock ezkl verifier bound to that agent's model, so escalation to Gold resolves
 *   - funded, approved consumer and challenger accounts
 *
 * Deliberately local-only: it mints an unlimited test token and prints private keys.
 *
 *   npx hardhat run scripts/seed.js --network localhost
 */

const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const Tier = { None: 0, Bronze: 1, Silver: 2, Gold: 3 };
const E18 = (n) => ethers.parseEther(String(n));

// Fixed keys so the relayer's .env can be written once and stay valid across re-seeds.
const OPERATOR_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const PUBLISHER_KEY = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";

// The model identity and its `input_scale`, read from circuits/spec.json — the same source
// deploy.js binds the real verifier from. These were a literal 8 and a literal `ethers.id(...)`
// here, which meant a change to the circuit's scale left the local seed silently disagreeing
// with every deployment: the tier that is meant to be the court of last resort would work in
// development and reject every honest proof in production, which is the worst direction for that
// particular disagreement to run.
const SPEC = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "..", "circuits", "spec.json"), "utf8")
);
const INPUT_SCALE_BITS = SPEC.inputScaleBits;

async function main() {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const file = path.join(__dirname, "..", "deployments", `${network.name}-${chainId}.json`);
  if (!fs.existsSync(file)) throw new Error(`no manifest at ${file} — run scripts/deploy.js first`);
  const m = JSON.parse(fs.readFileSync(file, "utf8"));

  if (![31337n, 1337n].includes(chainId)) throw new Error("seed.js is local-development only");

  const [deployer, , consumer, agentOwner, challenger] = await ethers.getSigners();
  const at = (name, key) => ethers.getContractAt(name, m.contracts[key ?? name]);

  const token = await at("MockERC20", "bondToken");
  const registry = await at("AgentRegistry");
  const attestor = await at("InputAttestor");
  const router = await at("ExecutionRouter");
  const zkAdapter = m.contracts.ZkAdapter ? await at("ZkAdapter") : null;

  const operator = new ethers.Wallet(OPERATOR_KEY, ethers.provider);
  const publisher = new ethers.Wallet(PUBLISHER_KEY, ethers.provider);

  // Gas for the off-chain actors.
  for (const w of [operator, publisher]) {
    await (await deployer.sendTransaction({ to: w.address, value: E18(10) })).wait();
  }

  await (await attestor.setPublisher(publisher.address, true)).wait();

  const modelCommitment = ethers.id(SPEC.name);

  for (const who of [consumer, agentOwner, challenger]) {
    await (await token.mint(who.address, E18(10_000_000))).wait();
    await (await token.connect(who).approve(await registry.getAddress(), ethers.MaxUint256)).wait();
    await (await token.connect(who).approve(await router.getAddress(), ethers.MaxUint256)).wait();
  }

  await (
    await registry
      .connect(agentOwner)
      .registerAgent(operator.address, modelCommitment, Tier.Bronze, 500, E18(1_000_000))
  ).wait();
  const agentId = await registry.agentIdByOperator(operator.address);

  // A challenged Bronze delivery escalates to Gold; without a verifier for this model the
  // agent could never answer a challenge, so the local setup would be unwinnable for it.
  let verifier = null;
  if (zkAdapter) {
    const mock = await (await ethers.getContractFactory("MockEzklVerifier")).deploy();
    await mock.waitForDeployment();
    verifier = await mock.getAddress();
    // The shift the reference circuit is compiled at — `input_scale` in circuits/spec.json.
    await (await zkAdapter.setVerifier(modelCommitment, verifier, INPUT_SCALE_BITS)).wait();
  }

  const seed = {
    ...m,
    seeded: {
      agentId: Number(agentId),
      agentOwner: agentOwner.address,
      operator: { address: operator.address, privateKey: OPERATOR_KEY },
      publisher: { address: publisher.address, privateKey: PUBLISHER_KEY },
      consumer: consumer.address,
      challenger: challenger.address,
      modelCommitment,
      ezklVerifier: verifier,
    },
  };
  fs.writeFileSync(file, JSON.stringify(seed, null, 2) + "\n");

  console.log(`\nseeded ${network.name} (chainId ${chainId})`);
  console.log(`  agentId       ${agentId}`);
  console.log(`  operator      ${operator.address}`);
  console.log(`  publisher     ${publisher.address}`);
  console.log(`  consumer      ${consumer.address}`);
  console.log(`  model         ${modelCommitment}`);
  console.log(`  ezklVerifier  ${verifier ?? "(none — Gold adapter not deployed)"}`);
  console.log(`\nmanifest updated -> ${path.relative(process.cwd(), file)}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

const { ethers, network } = require("hardhat");

const Tier = { None: 0, Bronze: 1, Silver: 2, Gold: 3 };
const Status = {
  None: 0,
  Pending: 1,
  Delivered: 2,
  Challenged: 3,
  Finalized: 4,
  Settled: 5,
  Expired: 6,
  Faulted: 7,
  Rejected: 8,
};

const E18 = (n) => ethers.parseEther(String(n));
const coder = ethers.AbiCoder.defaultAbiCoder();

const EXECUTION_TYPEHASH = ethers.keccak256(
  ethers.toUtf8Bytes(
    "Execution(bytes32 requestId,uint256 agentId,bytes32 modelCommitment,bytes32 inputCommitment,bytes32 outputCommitment,uint64 deliverBy)"
  )
);
const FEED_TYPEHASH = ethers.keccak256(
  ethers.toUtf8Bytes("FeedReading(bytes32 feedId,bytes32 valueHash,uint64 timestamp)")
);

// --------------------------------------------------------------- chain utils

async function now() {
  return (await ethers.provider.getBlock("latest")).timestamp;
}

async function increaseTime(seconds) {
  await network.provider.send("evm_increaseTime", [Number(seconds)]);
  await network.provider.send("evm_mine");
}

async function fundedWallet(funder, eth = "10") {
  const w = ethers.Wallet.createRandom().connect(ethers.provider);
  await funder.sendTransaction({ to: w.address, value: ethers.parseEther(eth) });
  return w;
}

/**
 * Sign an already-computed 32-byte digest.
 *
 * Still raw, and still correct: an EIP-712 digest *is* the thing a key signs, and neither the
 * `\x19\x01` envelope nor the domain is applied a second time here. What changed is what gets
 * passed in — the digests below are now enveloped, so a signature produced this way and one
 * produced by `wallet.signTypedData(...)` are the same bytes. `eip712.test.js` asserts exactly
 * that, which is the only real evidence that the envelope is correct.
 */
function signDigest(wallet, digest) {
  return new ethers.SigningKey(wallet.privateKey).sign(digest).serialized;
}

// --------------------------------------------------------------- digests

const DOMAIN_NAME = "BotID";
const DOMAIN_VERSION = "1";

/** Mirror of Digest.domainSeparator()'s inputs. */
function domain(chainId, verifyingContract) {
  return { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId, verifyingContract };
}

/**
 * Field lists, in order. `ethers.TypedDataEncoder` derives the typehash from these, so the
 * strings in `Digest.sol` and `InputAttestor.sol` are no longer transcribed here by hand —
 * a drift in either field list shows up as a failing signature rather than as a comment nobody
 * re-read. `eip712.test.js` also asserts the derived type strings directly.
 */
const EXECUTION_TYPES = {
  Execution: [
    { name: "requestId", type: "bytes32" },
    { name: "agentId", type: "uint256" },
    { name: "modelCommitment", type: "bytes32" },
    { name: "inputCommitment", type: "bytes32" },
    { name: "outputCommitment", type: "bytes32" },
    { name: "deliverBy", type: "uint64" },
  ],
};

const FEED_TYPES = {
  FeedReading: [
    { name: "feedId", type: "bytes32" },
    { name: "valueHash", type: "bytes32" },
    { name: "timestamp", type: "uint64" },
  ],
};

/**
 * Mirror of Digest.execution().
 *
 * Deliberately *not* a hand-rolled reimplementation of the same abi.encode: it goes through
 * ethers' own EIP-712 encoder. A mirror that repeats the contract's arithmetic agrees with the
 * contract even when both are wrong; an independent implementation of the published standard
 * disagrees, which is the whole point of having one.
 */
function executionDigest(chainId, verifier, ctx) {
  return ethers.TypedDataEncoder.hash(domain(chainId, verifier), EXECUTION_TYPES, {
    requestId: ctx.requestId,
    agentId: ctx.agentId,
    modelCommitment: ctx.modelCommitment,
    inputCommitment: ctx.inputCommitment,
    outputCommitment: ctx.outputCommitment,
    deliverBy: ctx.deliverBy,
  });
}

/** Mirror of InputAttestor.feedDigest(). Same reasoning as above. */
function feedDigest(chainId, attestor, feed) {
  return ethers.TypedDataEncoder.hash(domain(chainId, attestor), FEED_TYPES, {
    feedId: feed.feedId,
    valueHash: feed.valueHash,
    timestamp: feed.timestamp,
  });
}

/** Protocol convention for the preimage behind a signed `valueHash`. */
function valueHash(value, salt) {
  return ethers.keccak256(coder.encode(["int256", "bytes32"], [value, salt]));
}

/**
 * Build a publisher-signed input bundle plus its commitment.
 * Signers are sorted ascending by address — the attestor enforces strict ordering as dedup.
 *
 * A feed may carry either an opaque `valueHash` (enough for tests that never reach Gold) or a
 * `value`/`salt` pair, which is what a real publisher signs and what a Gold proof reveals.
 */
function buildBundle(chainId, attestorAddress, feeds, publishers) {
  const sorted = [...publishers].sort((a, b) =>
    a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1
  );

  const leaves = [];
  const encoded = [];
  for (const feed of feeds) {
    const hash = feed.valueHash ?? valueHash(feed.value, feed.salt);
    const digest = feedDigest(chainId, attestorAddress, { ...feed, valueHash: hash });
    leaves.push(digest);
    encoded.push([feed.feedId, hash, feed.timestamp, sorted.map((p) => signDigest(p, digest))]);
  }

  return {
    bundle: coder.encode(["tuple(bytes32,bytes32,uint64,bytes[])[]"], [encoded]),
    commitment: ethers.keccak256(coder.encode(["bytes32[]"], [leaves])),
  };
}

// --------------------------------------------------------------- gold tier

const BN254_P =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/**
 * The fixed-point shift the tests register their model at. Any non-zero value exercises the
 * quantisation path; 8 is what circuits/spec.json compiles the reference allocator with.
 */
const SCALE_BITS = 8;

/**
 * Signed value into the bn254 field element `ezkl` would emit for it, quantised by `bits`.
 *
 * Inputs are shifted because that is what the circuit does to them. Outputs are not: the adapter
 * never interprets an output cell, it only hashes the tail of the instance vector, so whatever
 * the circuit emitted is the number that has to be committed to.
 */
const toField = (v, bits = 0) => {
  const scaled = BigInt(v) << BigInt(bits);
  return scaled >= 0n ? scaled : BN254_P + scaled;
};

const REVEAL_TYPE = "tuple(bytes32,uint64,int256,bytes32)[]";

/** Turn bundle feeds into the reveals a Gold attestation opens them with. */
function revealsFor(feeds) {
  return feeds.map((f) => ({
    feedId: f.feedId,
    timestamp: f.timestamp,
    value: BigInt(f.value),
    salt: f.salt,
  }));
}

/**
 * Public instances a Gold proof must expose: the model's input tensor followed by its output
 * tensor, as field elements. Nothing else — the request binding is done on chain.
 */
function zkInstances(reveals, outputs, bits = SCALE_BITS) {
  return [...reveals.map((r) => toField(r.value, bits)), ...outputs.map((o) => toField(o))];
}

/** The commitment the circuit's output cells hash to. Mirrors the relayer's commitOutputs. */
function commitOutputs(outputs) {
  return ethers.keccak256(coder.encode(["uint256[]"], [outputs.map((o) => toField(o))]));
}

function zkAttestation(reveals, outputs, proof = "0xdeadbeef", bits = SCALE_BITS) {
  return coder.encode(
    ["bytes", "uint256[]", REVEAL_TYPE],
    [
      proof,
      zkInstances(reveals, outputs, bits),
      reveals.map((r) => [r.feedId, r.timestamp, r.value, r.salt]),
    ]
  );
}

function teeAttestation(enclaveKey, signature) {
  return coder.encode(["address", "bytes"], [enclaveKey, signature]);
}

// --------------------------------------------------------------- deployment

/**
 * `decimals` deploys the bond token at something other than 18 and mints in that token's own
 * units. It does NOT retune the contracts' capital parameters — those keep their 18-decimal
 * initialisers, which is precisely the state a deploy lands in before deploy.js rescales them,
 * and the state Decimals.test.js exists to characterise.
 *
 * `bootstrapped` closes the deployment window, putting the wiring setters behind the 21-day
 * timelock. It defaults to *false*, and that default is a deliberate compromise worth stating
 * plainly: most of this suite uses `setRouter` and `setWriter` as fixtures — impersonating the
 * router to reach a code path directly — and a three-week wait in front of each of them would
 * turn those tests into tests of the timelock. Timelock.test.js passes `true` and exercises the
 * real configuration; everywhere else, `bootstrapped()` is false and the setters run immediately,
 * which is exactly the state a freshly deployed protocol is in.
 */
async function deployProtocol({ decimals = 18, bootstrapped = false } = {}) {
  const [owner, treasury, consumer, agentOwner, challenger, other] = await ethers.getSigners();
  const chainId = (await ethers.provider.getNetwork()).chainId;

  const token = await (await ethers.getContractFactory("MockERC20")).deploy();
  if (decimals !== 18) await (await token.setDecimals(decimals)).wait();
  const units = (n) => ethers.parseUnits(String(n), decimals);
  const engine = await (await ethers.getContractFactory("ReputationEngine")).deploy(owner.address);
  const registry = await (
    await ethers.getContractFactory("AgentRegistry")
  ).deploy(owner.address, token.target, engine.target, treasury.address);
  const attestor = await (await ethers.getContractFactory("InputAttestor")).deploy(owner.address);
  const router = await (
    await ethers.getContractFactory("ExecutionRouter")
  ).deploy(
    owner.address,
    registry.target,
    engine.target,
    token.target,
    attestor.target,
    treasury.address
  );

  const sigAdapter = await (await ethers.getContractFactory("SignatureAdapter")).deploy();
  const teeAdapter = await (await ethers.getContractFactory("TeeAdapter")).deploy(owner.address);
  const zkAdapter = await (
    await ethers.getContractFactory("ZkAdapter")
  ).deploy(owner.address, attestor.target);
  const verifier = await (await ethers.getContractFactory("MockEzklVerifier")).deploy();

  await engine.setWriter(registry.target, true);
  await engine.setWriter(router.target, true);
  await registry.setRouter(router.target);
  await zkAdapter.setRouter(router.target);
  await router.setAdapter(Tier.Bronze, sigAdapter.target);
  await router.setAdapter(Tier.Silver, teeAdapter.target);
  await router.setAdapter(Tier.Gold, zkAdapter.target);

  if (bootstrapped) {
    await engine.finalizeBootstrap();
    await registry.finalizeBootstrap();
    await router.finalizeBootstrap();
    await zkAdapter.finalizeBootstrap();
  }

  // One publisher, quorum of 1, is enough for most tests; multi-publisher cases override.
  const publisher = await fundedWallet(owner, "1");
  await attestor.setPublisher(publisher.address, true);

  for (const who of [consumer, agentOwner, challenger, other]) {
    await token.mint(who.address, units(10_000_000));
    await token.connect(who).approve(registry.target, ethers.MaxUint256);
    await token.connect(who).approve(router.target, ethers.MaxUint256);
  }

  return {
    chainId,
    decimals,
    units,
    owner,
    treasury,
    consumer,
    agentOwner,
    challenger,
    other,
    token,
    engine,
    registry,
    attestor,
    router,
    sigAdapter,
    teeAdapter,
    zkAdapter,
    verifier,
    publisher,
  };
}

/** Register an agent and return its id, operator wallet and model commitment. */
async function registerAgent(env, overrides = {}) {
  const {
    tier = Tier.Bronze,
    bond = E18(1_000_000),
    lossToleranceBps = 500,
    model = ethers.id("model-v1"),
  } = overrides;

  const operator = await fundedWallet(env.owner, "10");
  const tx = await env.registry
    .connect(env.agentOwner)
    .registerAgent(operator.address, model, tier, lossToleranceBps, bond);
  await tx.wait();

  const agentId = await env.registry.agentIdByOperator(operator.address);
  return { agentId, operator, model };
}

module.exports = {
  Tier,
  Status,
  E18,
  coder,
  now,
  increaseTime,
  fundedWallet,
  signDigest,
  DOMAIN_NAME,
  DOMAIN_VERSION,
  domain,
  EXECUTION_TYPEHASH,
  FEED_TYPEHASH,
  EXECUTION_TYPES,
  FEED_TYPES,
  executionDigest,
  feedDigest,
  valueHash,
  buildBundle,
  BN254_P,
  SCALE_BITS,
  toField,
  revealsFor,
  commitOutputs,
  zkInstances,
  zkAttestation,
  teeAttestation,
  deployProtocol,
  registerAgent,
};

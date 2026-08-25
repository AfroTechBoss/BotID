const { ethers } = require("ethers");

const coder = ethers.AbiCoder.defaultAbiCoder();

// Everything a signature in this protocol commits to, in one place.
//
// Both digests are EIP-712: `keccak256(0x1901 || domainSeparator || structHash)`. That envelope
// is what lets a hardware wallet render a delivery or a price reading instead of asking an
// operator to approve 32 opaque bytes, and it is why the field lists below are declared as types
// rather than transcribed as hashes — `ethers.TypedDataEncoder` derives the typehash from them,
// so a drift in a field list changes the digest instead of being invisible.
//
// The domain name and version are part of the separator, so changing either invalidates every
// signature issued under the old pair. `chain.js` reads `DOMAIN_SEPARATOR()` off the deployed
// attestor at startup and refuses to run on a mismatch.
const DOMAIN_NAME = "BotID";
const DOMAIN_VERSION = "1";

/** The EIP-712 domain for a verifying contract. Mirror of `Digest.domainSeparator`. */
function domain(chainId, verifyingContract) {
  return { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId, verifyingContract };
}

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

// Kept, and now *derived* rather than transcribed: these are what `chain.js` compares against
// the deployed contracts, and deriving them from the type lists above means the check is testing
// the same thing the signing path uses. A hand-written copy could agree with the chain while
// disagreeing with the signature this process actually produces.
const EXECUTION_TYPEHASH = ethers.keccak256(
  ethers.toUtf8Bytes(ethers.TypedDataEncoder.from(EXECUTION_TYPES).encodeType("Execution"))
);
const FEED_TYPEHASH = ethers.keccak256(
  ethers.toUtf8Bytes(ethers.TypedDataEncoder.from(FEED_TYPES).encodeType("FeedReading"))
);

const BUNDLE_TYPE = "tuple(bytes32,bytes32,uint64,bytes[])[]";

/** Mirror of Digest.execution(). `verifier` is the adapter address, and binding it — now as the
 *  domain's `verifyingContract` — is what stops a Bronze signature being replayed at the TEE or
 *  ZK adapter. */
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

/** Mirror of InputAttestor.feedDigest(). */
function feedDigest(chainId, attestor, feed) {
  return ethers.TypedDataEncoder.hash(domain(chainId, attestor), FEED_TYPES, {
    feedId: feed.feedId,
    valueHash: feed.valueHash,
    timestamp: feed.timestamp,
  });
}

/**
 * The typed-data payload for a delivery, for a signer that can render it.
 *
 * `signDigest` below still works and produces identical bytes, but it asks a key to sign a hash.
 * This is what to hand a hardware wallet or a remote signing service: `signer.signTypedData(
 * ...executionTypedData(chainId, adapter, ctx))` shows the request id, the agent and the deadline
 * as text before anything is signed.
 */
function executionTypedData(chainId, verifier, ctx) {
  return [
    domain(chainId, verifier),
    EXECUTION_TYPES,
    {
      requestId: ctx.requestId,
      agentId: ctx.agentId,
      modelCommitment: ctx.modelCommitment,
      inputCommitment: ctx.inputCommitment,
      outputCommitment: ctx.outputCommitment,
      deliverBy: ctx.deliverBy,
    },
  ];
}

/** The same, for one feed reading. See `executionTypedData`. */
function feedTypedData(chainId, attestor, feed) {
  return [
    domain(chainId, attestor),
    FEED_TYPES,
    { feedId: feed.feedId, valueHash: feed.valueHash, timestamp: feed.timestamp },
  ];
}

/** Mirror of InputAttestor's commitment: keccak over the ordered leaf digests. */
function bundleCommitment(chainId, attestor, feeds) {
  const leaves = feeds.map((f) => feedDigest(chainId, attestor, f));
  return ethers.keccak256(coder.encode(["bytes32[]"], [leaves]));
}

/**
 * Encode a signed bundle. Signatures per reading must be in strictly ascending signer order —
 * the attestor uses that ordering as its dedup check and rejects anything else.
 */
function encodeBundle(feeds) {
  return coder.encode(
    [BUNDLE_TYPE],
    [feeds.map((f) => [f.feedId, f.valueHash, f.timestamp, f.signatures])]
  );
}

function decodeBundle(hex) {
  const [rows] = coder.decode([BUNDLE_TYPE], hex);
  return rows.map((r) => ({
    feedId: r[0],
    valueHash: r[1],
    timestamp: Number(r[2]),
    signatures: [...r[3]],
  }));
}

// ------------------------------------------------------------------ gold tier

/** bn254 scalar field. Same constant as ZkAdapter.P and circuits/common.py's P. */
const BN254_P =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** ZkAdapter refuses magnitudes at or beyond this before reduction, so a reveal of the literal
 *  integer `P - 42` cannot produce the same instance cell as `-42`. */
const MAX_ABS = 1n << 128n;

/**
 * Signed value -> the bn254 field element `ezkl` puts in the instance cell.
 *
 * Mirror of `ZkAdapter._toField` and of `to_field` in `circuits/common.py`. All three have to
 * agree exactly; a disagreement rejects every honest Gold proof for the model, silently and
 * without any single party being at fault. The bound is checked *before* the shift, matching
 * the adapter.
 */
function toField(v, bits = 0) {
  const n = BigInt(v);
  const shift = BigInt(bits);
  const limit = MAX_ABS >> shift;
  if (n >= limit || n <= -limit) {
    throw new Error(`value ${n} is outside the range ZkAdapter accepts at scale ${bits}`);
  }
  const scaled = n << shift;
  return scaled >= 0n ? scaled : BN254_P + scaled;
}

/**
 * The protocol's preimage convention for a signed `valueHash`.
 *
 * A bundle commits to a hash, not to a number, so this is what makes a Gold reveal possible at
 * all: `ZkAdapter._commit` recomputes exactly this from the opened values and requires the
 * result to reproduce the consumer's `inputCommitment`.
 */
function valueHash(value, salt) {
  return ethers.keccak256(coder.encode(["int256", "bytes32"], [value, salt]));
}

/** ABI shape of `ZkAdapter.Reveal[]`. */
const REVEAL_TYPE = "tuple(bytes32,uint64,int256,bytes32)[]";

/**
 * Public instances a Gold proof must expose: the model's input tensor followed by its output
 * tensor, and nothing else.
 *
 * `outputs` are already field elements — they come straight out of the witness, and the adapter
 * never interprets an output cell, it only hashes the tail of the vector. Inputs are quantised
 * here because that is what the circuit does to them on the way in.
 */
function zkInstances(reveals, outputs = [], bits = 0) {
  return [...reveals.map((r) => toField(r.value, bits)), ...outputs.map(BigInt)];
}

/** `abi.encode(bytes proof, uint256[] instances, Reveal[] reveals)` — the Gold attestation. */
function encodeZkAttestation(proof, instances, reveals) {
  return coder.encode(
    ["bytes", "uint256[]", REVEAL_TYPE],
    [proof, instances, reveals.map((r) => [r.feedId, r.timestamp, r.value, r.salt])]
  );
}

/**
 * Sign an already-computed 32-byte digest.
 *
 * No prefix is applied here and none is needed: the digests above already carry the `\x19\x01`
 * envelope, so this produces the same bytes as `signTypedData` over the same message. Use it when
 * the key is a local hot wallet and there is nobody to show the message to. When there *is* —
 * a hardware wallet, an operator approving a delivery — prefer `executionTypedData` and
 * `feedTypedData`, which is the entire reason the envelope exists.
 */
function signDigest(wallet, digest) {
  return new ethers.SigningKey(wallet.privateKey).sign(digest).serialized;
}

module.exports = {
  coder,
  DOMAIN_NAME,
  DOMAIN_VERSION,
  domain,
  EXECUTION_TYPES,
  FEED_TYPES,
  EXECUTION_TYPEHASH,
  FEED_TYPEHASH,
  executionDigest,
  feedDigest,
  executionTypedData,
  feedTypedData,
  bundleCommitment,
  encodeBundle,
  decodeBundle,
  BN254_P,
  toField,
  valueHash,
  REVEAL_TYPE,
  zkInstances,
  encodeZkAttestation,
  signDigest,
};

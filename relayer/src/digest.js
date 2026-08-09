const { ethers } = require("ethers");

const coder = ethers.AbiCoder.defaultAbiCoder();

// These two constants must stay byte-identical to Digest.sol and InputAttestor.sol. Every
// signature this process produces is worthless — or worse, valid for the wrong thing — if they
// drift, so they are asserted against the deployed contracts on startup (see chain.js).
const EXECUTION_TYPEHASH = ethers.keccak256(
  ethers.toUtf8Bytes(
    "Execution(bytes32 requestId,uint256 agentId,bytes32 modelCommitment,bytes32 inputCommitment,bytes32 outputCommitment,uint64 deliverBy)"
  )
);
const FEED_TYPEHASH = ethers.keccak256(
  ethers.toUtf8Bytes("FeedReading(bytes32 feedId,bytes32 valueHash,uint64 timestamp)")
);

const BUNDLE_TYPE = "tuple(bytes32,bytes32,uint64,bytes[])[]";

/** Mirror of Digest.execution(). `verifier` is the adapter address, and binding it is what
 *  stops a Bronze signature from being replayed at the TEE or ZK adapter. */
function executionDigest(chainId, verifier, ctx) {
  return ethers.keccak256(
    coder.encode(
      [
        "bytes32", "uint256", "address", "bytes32",
        "uint256", "bytes32", "bytes32", "bytes32", "uint64",
      ],
      [
        EXECUTION_TYPEHASH,
        chainId,
        verifier,
        ctx.requestId,
        ctx.agentId,
        ctx.modelCommitment,
        ctx.inputCommitment,
        ctx.outputCommitment,
        ctx.deliverBy,
      ]
    )
  );
}

/** Mirror of InputAttestor.feedDigest(). */
function feedDigest(chainId, attestor, feed) {
  return ethers.keccak256(
    coder.encode(
      ["bytes32", "uint256", "address", "bytes32", "bytes32", "uint64"],
      [FEED_TYPEHASH, chainId, attestor, feed.feedId, feed.valueHash, feed.timestamp]
    )
  );
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

/** Sign a raw 32-byte digest. No EIP-191 prefix: the contracts ecrecover the digest itself. */
function signDigest(wallet, digest) {
  return new ethers.SigningKey(wallet.privateKey).sign(digest).serialized;
}

module.exports = {
  coder,
  EXECUTION_TYPEHASH,
  FEED_TYPEHASH,
  executionDigest,
  feedDigest,
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

const { execFile } = require("child_process");
const { promisify } = require("util");
const { ethers } = require("ethers");
const config = require("./config");
const { log } = require("./util");
const {
  coder,
  executionDigest,
  zkInstances,
  encodeZkAttestation,
  signDigest,
} = require("./digest");

const execFileAsync = promisify(execFile);
const Tier = { None: 0, Bronze: 1, Silver: 2, Gold: 3 };

/**
 * Bronze — the operator's own signature over the execution digest.
 *
 * This proves only that the keyholder is willing to be slashed for the claim. That is the
 * point: it is cheap, and it is made honest by the challenge window, not by cryptography.
 */
function bronze(chainId, adapterAddress, ctx, operatorWallet) {
  return signDigest(operatorWallet, executionDigest(chainId, adapterAddress, ctx));
}

/**
 * Silver — a signature from a key that only exists inside an attested enclave.
 *
 * The measurement is bound into the signed digest, so an enrolment cannot be reused across
 * builds. Note the honest limitation carried over from TeeAdapter: enrolment is notarised
 * rather than parsed on chain, so the trust root here is the notary set, not the CPU vendor.
 */
function silver(chainId, adapterAddress, ctx, enclaveWallet, measurement) {
  const digest = ethers.keccak256(
    coder.encode(["bytes32", "bytes32"], [executionDigest(chainId, adapterAddress, ctx), measurement])
  );
  return coder.encode(["address", "bytes"], [enclaveWallet.address, signDigest(enclaveWallet, digest)]);
}

/**
 * Gold — a Groth16 proof whose public instances bind this exact execution.
 *
 *   abi.encode(bytes proof, uint256[] instances, Reveal[] reveals)
 *
 * The instance vector is the model's input tensor followed by its output tensor, and nothing
 * else. Nothing protocol-specific is in the circuit: `inputCommitment` and `outputCommitment`
 * are keccak commitments, halo2 cannot compute keccak without a gadget `ezkl` does not expose,
 * and binding them on chain costs 6 gas a word and checks against the router's own storage
 * rather than against a number the prover chose. `ZkAdapter.sol` argues this out in full.
 *
 * `reveals` is what makes the input half checkable at all — a bundle commits to a `valueHash`,
 * so the adapter needs the preimages to re-derive both the commitment and the input cells.
 * `scaleBits` is read off the chain by the caller, not guessed here.
 *
 * The prover is `circuits/prove.py` by default. `EZKL_PROVER_CMD` replaces it with anything that
 * takes the same JSON job on argv and prints either `{"proof": "0x…"}` or bare hex on stdout —
 * a proving queue, a bigger machine, a signing HSM. Faking this would be the single most
 * misleading thing this file could do, so an unconfigured Gold tier fails loudly instead.
 */
async function gold(ctx, { outputs, reveals, scaleBits }) {
  if (!reveals || reveals.length === 0) {
    throw new Error("Gold tier needs opened feed values — the bundle was served without readings");
  }
  const instances = zkInstances(reveals, outputs, scaleBits);

  if (config.allowDevProof) {
    // Overrides the prover entirely, and says so every time. Only meaningful against
    // MockEzklVerifier, which ignores the proof bytes: a real verifier rejects this, which is
    // the correct outcome for a relayer that has been told not to actually prove anything.
    log.warn("ALLOW_DEV_PROOF is set — emitting correct instances with an empty proof");
    return encodeZkAttestation("0x", instances, reveals);
  }

  const job = JSON.stringify({
    values: reveals.map((r) => r.value.toString()),
    instances: instances.map(String),
  });

  const { stdout } = await execFileAsync(config.proverCmd, [...config.proverArgs, job], {
    cwd: config.circuitsDir,
    maxBuffer: 1 << 28,
  });

  const proof = parseProof(stdout);
  if (!/^0x[0-9a-fA-F]*$/.test(proof)) throw new Error("prover did not return hex proof bytes");

  return encodeZkAttestation(proof, instances, reveals);
}

/**
 * `prove.py` prints a JSON object; a hand-rolled `EZKL_PROVER_CMD` may just print hex. Accept
 * both, and read only the last line so a prover that logs progress to stdout still works.
 */
function parseProof(stdout) {
  const last = stdout.trim().split(/\r?\n/).pop().trim();
  if (last.startsWith("{")) {
    const out = JSON.parse(last);
    if (!out.proof) throw new Error("prover returned JSON with no `proof` field");
    return out.proof;
  }
  return last;
}

/** Build whatever artifact the agent's registered tier calls for. */
async function forTier(
  tier,
  { chainId, adapters, ctx, operator, enclave, measurement, outputs, reveals, scaleBits }
) {
  switch (Number(tier)) {
    case Tier.Bronze:
      return bronze(chainId, adapters.bronze, ctx, operator);
    case Tier.Silver:
      if (!enclave) throw new Error("Silver tier requires ENCLAVE_KEY");
      if (!measurement) throw new Error("Silver tier requires MEASUREMENT");
      return silver(chainId, adapters.silver, ctx, enclave, measurement);
    case Tier.Gold:
      return gold(ctx, { outputs, reveals, scaleBits });
    default:
      throw new Error(`agent has no verification tier (${tier})`);
  }
}

module.exports = { Tier, bronze, silver, gold, forTier };

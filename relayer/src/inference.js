const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { ethers } = require("ethers");
const config = require("./config");
const { coder } = require("./digest");

const execFileAsync = promisify(execFile);

/**
 * The model boundary.
 *
 * A runner takes the opened feed values and returns the model's output cells plus the commitment
 * the protocol will bind. Two constraints, both non-negotiable:
 *
 *   1. It must be deterministic. Bronze is challengeable and Silver is escalatable, so the same
 *      inputs have to reproduce the same outputs later, under a ZK circuit, or the agent loses
 *      a challenge it was honest about.
 *   2. Its outputs must be the circuit's output cells, not a rounded human-readable version of
 *      them. `ZkAdapter` hashes the tail of the instance vector and compares it to what was
 *      delivered; a weight of 100% is the cell `10000 << inputScaleBits`, not `10000`.
 */

/**
 * The commitment over a model's output cells. Mirrors `ZkAdapter.outputCommitmentFor` and
 * `_bindsOutputs`, both of which are `keccak256(abi.encode(uint256[]))` over the same numbers.
 */
function commitOutputs(outputs) {
  return ethers.keccak256(coder.encode(["uint256[]"], [outputs.map(BigInt)]));
}

/**
 * The runner that actually matters: `circuits/run.py`, the same entrypoint the prover calls.
 *
 * Running the circuit at every tier is the point. The output commitment goes on chain at
 * delivery, long before anyone asks for a proof, so an agent that computes its answer with a
 * hand-written reimplementation and differs from the circuit in the last digit has already
 * committed to a number it cannot later prove. Shelling out to the circuit makes the tiers agree
 * by construction instead of by review.
 *
 * The subprocess cost — a Python start-up per request — is real and is worth it. If it ever
 * isn't, the fix is a long-lived worker speaking the same JSON, not a second implementation.
 */
class EzklRunner {
  constructor(modelCommitment) {
    this.modelCommitment = modelCommitment;
    this.cmd = config.runnerCmd;
    this.args = config.runnerArgs;
    this.cwd = config.circuitsDir;

    // The agent is registered for a model commitment; this directory holds *a* circuit. Nothing
    // downstream compares them — the adapter checks the proof against the verifier registered
    // for the commitment, so a mismatch shows up as a rejected proof after the work is done and
    // the delivery is made. Checking the name here turns that into a startup error.
    const name = JSON.parse(fs.readFileSync(path.join(this.cwd, "spec.json"), "utf8")).name;
    const built = ethers.id(name);
    if (built.toLowerCase() !== String(modelCommitment).toLowerCase()) {
      throw new Error(
        `the circuit in ${this.cwd} is "${name}" (${built}), but this agent is registered for ` +
          `${modelCommitment} — a model commitment is keccak256(utf8(name)), and reputation ` +
          "does not transfer between models"
      );
    }
  }

  /** Fails at construction time rather than on the first request with a deadline attached. */
  static available() {
    return fs.existsSync(path.join(config.circuitsDir, "build", "model.compiled"));
  }

  async run(feeds, reveals) {
    if (!reveals) {
      throw new Error(
        "the circuit runner needs opened feed values, but the bundle was served without " +
          "readings — see publisher.open()"
      );
    }

    const job = JSON.stringify({ values: reveals.map((r) => r.value.toString()) });
    const { stdout } = await execFileAsync(this.cmd, [...this.args, job], {
      cwd: this.cwd,
      maxBuffer: 1 << 26,
    });

    let out;
    try {
      out = JSON.parse(stdout.trim().split(/\r?\n/).pop());
    } catch {
      throw new Error(`circuit runner did not return JSON:\n${stdout.slice(0, 500)}`);
    }

    // The runner already asserts that its input cells are the quantised feed values; this is the
    // other half of the same idea, and it is cheap.
    if (!Array.isArray(out.outputs) || out.outputs.length === 0) {
      throw new Error("circuit runner returned no output cells");
    }

    const outputs = out.outputs.map(BigInt);
    return { outputs, weights: out.weights, outputCommitment: commitOutputs(outputs) };
  }
}

/**
 * A pure-JS port of the integer reference in `circuits/export_onnx.py`: equal weight among
 * above-average feeds, in basis points.
 *
 * This is not an approximation of the circuit. `pipeline.py` refuses to hand over a proving key
 * it has not watched reproduce this exact function on every calibration sample, so the two agree
 * by test rather than by hope. It exists for environments without a Python toolchain and for the
 * unit tests, and it is a liability the moment `spec.json` changes without it — which is why
 * `EzklRunner` is the default and this has to be asked for by name.
 */
class ReferenceAllocator {
  constructor(modelCommitment, scaleBits) {
    this.modelCommitment = modelCommitment;
    this.scaleBits = BigInt(scaleBits);
    this.bps = 10_000n;
  }

  async run(feeds, reveals) {
    if (!reveals) throw new Error("the reference allocator needs opened feed values");
    const x = reveals.map((r) => BigInt(r.value));
    if (x.length === 0) return { outputs: [], weights: [], outputCommitment: commitOutputs([]) };

    const n = BigInt(x.length);
    const total = x.reduce((a, b) => a + b, 0n);
    // `ind[i]` is 1 where the feed is strictly above the mean. Written as `n*x - sum` rather
    // than a division so it matches the graph the circuit compiles, sign for sign.
    const ind = x.map((v) => (n * v - total > 0n ? 1n : 0n));
    const k = ind.reduce((a, b) => a + b, 0n);
    const weights = ind.map((i) => (i * this.bps) / (k > 0n ? k : 1n));

    const outputs = weights.map((w) => w << this.scaleBits);
    return { outputs, weights, outputCommitment: commitOutputs(outputs) };
  }
}

/**
 * Pick a runner. `MODEL_RUNNER=reference` opts into the JS port; anything else gets the circuit.
 *
 * The failure when the circuit is not built is deliberate and loud. Falling back to the JS port
 * automatically would let a host with a broken Python environment deliver commitments it cannot
 * prove, and it would do so silently — the exact class of drift the Gold tier exists to make
 * impossible.
 */
function loadRunner(modelCommitment, scaleBits) {
  if (config.modelRunner === "reference") {
    return new ReferenceAllocator(modelCommitment, scaleBits);
  }
  if (!EzklRunner.available()) {
    throw new Error(
      `no compiled circuit at ${config.circuitsDir}/build/model.compiled — run ` +
        "circuits/pipeline.py, or set MODEL_RUNNER=reference to use the JS port of the " +
        "integer reference instead"
    );
  }
  return new EzklRunner(modelCommitment);
}

module.exports = { commitOutputs, EzklRunner, ReferenceAllocator, loadRunner };

const fs = require("fs");
const path = require("path");

/**
 * Minimal .env loader. The relayer's only runtime dependency is ethers; pulling in dotenv for
 * fifteen lines of parsing is not worth the supply-chain surface on a key-holding process.
 */
function loadEnv(file = path.join(__dirname, "..", ".env")) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue; // real env wins
    process.env[key] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
}

loadEnv();

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing required environment variable ${name}`);
  return v;
}

/** Contract addresses come from the deploy manifest, not from hand-copied env vars. */
function loadManifest() {
  const file =
    process.env.MANIFEST ??
    path.join(__dirname, "..", "..", "contracts", "deployments", "localhost-31337.json");
  if (!fs.existsSync(file)) {
    throw new Error(`no deployment manifest at ${file} — set MANIFEST or run contracts/scripts/deploy.js`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const config = {
  rpcUrl: process.env.RPC_URL ?? "http://127.0.0.1:8545",
  manifest: loadManifest,
  required,

  artifactsDir:
    process.env.ARTIFACTS_DIR ?? path.join(__dirname, "..", "..", "contracts", "artifacts", "src"),

  // Agent identity. AGENT_ID is checked against the operator key on startup.
  agentId: process.env.AGENT_ID ? BigInt(process.env.AGENT_ID) : null,
  operatorKey: process.env.OPERATOR_KEY ?? null,

  // Silver: the enclave signing key, when running inside a TEE.
  enclaveKey: process.env.ENCLAVE_KEY ?? null,
  measurement: process.env.MEASUREMENT ?? null,

  // The circuit. `run.py` is the inference path for every tier, not just Gold — see
  // src/inference.js for why a second implementation is worse than a subprocess.
  circuitsDir: process.env.CIRCUITS_DIR ?? path.join(__dirname, "..", "..", "circuits"),
  modelRunner: process.env.MODEL_RUNNER ?? "ezkl",
  runnerCmd: process.env.PYTHON ?? "python",
  runnerArgs: ["run.py"],

  // Gold: the prover. Same interpreter, different entrypoint; overridable as one command for
  // hosts that put proving behind a queue or a bigger machine.
  proverCmd: process.env.EZKL_PROVER_CMD ?? (process.env.PYTHON ?? "python"),
  proverArgs: process.env.EZKL_PROVER_CMD ? [] : ["prove.py"],
  allowDevProof: process.env.ALLOW_DEV_PROOF === "true",

  // Where the demo consumer writes bundles and the relayer reads them from.
  bundleDir: process.env.BUNDLE_DIR ?? path.join(__dirname, "..", ".bundles"),

  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 5000),
  confirmations: Number(process.env.CONFIRMATIONS ?? 1),
  startBlock: process.env.START_BLOCK ? Number(process.env.START_BLOCK) : null,
};

module.exports = config;

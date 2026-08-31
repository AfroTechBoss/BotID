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

/**
 * Contract addresses come from the deploy manifest, not from hand-copied env vars.
 *
 * `config.contracts` short-circuits this entirely: a library caller passes addresses in and never
 * touches the filesystem, because an npm install has no deployments directory to read.
 */
function loadManifest() {
  if (config.contracts) {
    return { chainId: config.chainId, contracts: config.contracts, seeded: config.seeded };
  }
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

  // Set only by a library caller (see apply). Null means "read the deploy manifest off disk",
  // which is what the CLI does.
  contracts: null,
  chainId: null,
  seeded: null,

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

  // An `inputURI` comes from whoever made the request, and fetching it happens from inside the
  // operator's network before anything is verified. Off by default, private addresses are
  // refused; see publisher.fetchBundle. Turn it on only to serve bundles from your own network.
  allowPrivateInputURI: process.env.ALLOW_PRIVATE_INPUT_URI === "true",

  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 5000),
  confirmations: Number(process.env.CONFIRMATIONS ?? 1),
  startBlock: process.env.START_BLOCK ? Number(process.env.START_BLOCK) : null,

  // --- arena ---------------------------------------------------------------
  // The first-party consumer. See src/arena/ and docs/arena.md; every one of these is a
  // policy choice rather than a protocol constant, which is why none of them is read from
  // the chain.
  arena: {
    ledgerFile: process.env.ARENA_LEDGER ?? path.join(__dirname, "..", ".arena", "ledger.json"),

    // Exactly `spec.json.feeds` of them, in a fixed order. The order is part of what the
    // model sees, so shuffling it between requests would change the answer for reasons that
    // have nothing to do with the market.
    assets: (process.env.ARENA_ASSETS ?? "BTC/USD,ETH/USD,SOL/USD").split(",").map((s) => s.trim()),

    // Hours of price history behind each feed reading. The feed value is a rebased index,
    // not a price — see market.js for why a raw price cannot go in there at all.
    lookbackHours: Number(process.env.ARENA_LOOKBACK_HOURS ?? 24),

    // How long the allocation is held before it is graded, in hours. Must sit strictly
    // between the router's challenge window (1h) and its settlement window (7d); checked at
    // startup against the deployed values rather than trusted.
    holdHours: Number(process.env.ARENA_HOLD_HOURS ?? 24),

    // Seconds an agent gets to deliver.
    deliverWindowSec: Number(process.env.ARENA_DELIVER_WINDOW_SEC ?? 900),

    // Notional per job, as a fraction of the agent's own credit line in bps. A constant
    // would either revert against a small agent or carry no weight against a large one.
    notionalBps: Number(process.env.ARENA_NOTIONAL_BPS ?? 2_500),

    // Minimum gap between two Arena jobs for the same agent, in seconds.
    cooldownSec: Number(process.env.ARENA_COOLDOWN_SEC ?? 3_600),

    // Hard ceiling on fees the Arena will spend, in whole bond-token units. Checked before
    // ordering: the fee budget is finite on any network where the bond token is real, and
    // discovering that by revert is discovering it too late.
    feeBudget: process.env.ARENA_FEE_BUDGET ?? null,

    orderIntervalMs: Number(process.env.ARENA_ORDER_INTERVAL_MS ?? 300_000),
    settleIntervalMs: Number(process.env.ARENA_SETTLE_INTERVAL_MS ?? 300_000),

    // Block AgentRegistered replay starts from. Falls back to START_BLOCK, then to a short
    // lookback — the same shape as the watchtower, for the same reason: a public RPC refuses
    // an unbounded eth_getLogs, so "from genesis" is not an option.
    fromBlock: process.env.ARENA_FROM_BLOCK ? Number(process.env.ARENA_FROM_BLOCK) : null,
    logWindow: Number(process.env.ARENA_LOG_WINDOW ?? 9_000),

    priceSource: process.env.ARENA_PRICE_SOURCE ?? "coinbase",

    // Where a *remote* agent can fetch the bundle. Without this the Arena emits a bare name,
    // which only resolves for an agent sharing this filesystem — fine for the local demo and
    // useless on a public testnet, where the agent is on somebody else's machine and a name
    // it cannot resolve is a delivery it cannot make.
    bundleBaseUrl: process.env.ARENA_BUNDLE_BASE_URL ?? null,
  },

  // --- alerts --------------------------------------------------------------
  // The alert daemon only. It is the one mode here that holds no key at all — it reads the
  // chain, reads a table the interface writes, and makes outbound HTTP requests. Nothing it
  // does can be signed, which is deliberate: it runs beside the watchtower and should not be
  // able to spend anything if it is compromised.
  alerts: {
    databaseUrl: process.env.DATABASE_URL ?? null,

    // Score decays continuously, so a threshold can be crossed with no transaction anywhere on
    // chain. Following logs alone misses exactly the alert a consumer most wants.
    sweepIntervalMs: Number(process.env.ALERT_SWEEP_INTERVAL_MS ?? 300_000),

    // Consecutive failures before a subscription is disabled. A dead endpoint retried forever
    // is a slow outbound scanner pointed at someone else's infrastructure.
    maxFailures: Number(process.env.ALERT_MAX_FAILURES ?? 10),

    // Same shape as the Arena's, for the same reason: a public RPC refuses an unbounded
    // eth_getLogs, so a scan is a sequence of windows and "from genesis" is not an option.
    fromBlock: process.env.ALERT_FROM_BLOCK ? Number(process.env.ALERT_FROM_BLOCK) : null,
    logWindow: Number(process.env.ALERT_LOG_WINDOW ?? 9_000),

    deliverTimeoutMs: Number(process.env.ALERT_DELIVER_TIMEOUT_MS ?? 10_000),
  },
};

/** Keys `apply` accepts, so a typo is an error rather than a setting that silently does nothing. */
const SETTABLE = new Set([
  "rpcUrl", "contracts", "chainId", "seeded", "artifactsDir", "agentId", "operatorKey",
  "enclaveKey", "measurement", "circuitsDir", "modelRunner", "runnerCmd", "runnerArgs",
  "proverCmd", "proverArgs", "allowDevProof", "bundleDir", "allowPrivateInputURI",
  "pollIntervalMs", "confirmations", "startBlock", "arena", "alerts",
]);

let applied = null;

/**
 * Overlay explicit settings onto the environment-derived defaults.
 *
 * This module is a singleton, which is the right shape for a CLI — one process, one operator key,
 * read once at startup — and a compromise for a library. Rather than let a second caller quietly
 * reconfigure a running agent, a conflicting `apply` throws: one process runs one agent, and two
 * agents means two processes. That is the deployment shape anyway, since each one holds a
 * different key and a key-holding process should be the smallest thing you can restart.
 *
 * Re-applying identical settings is fine — a caller that constructs the same agent twice has not
 * asked for anything contradictory.
 */
function apply(options = {}) {
  const next = {};
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined) continue;
    if (!SETTABLE.has(key)) throw new Error(`unknown BotID option: ${key}`);
    next[key] = key === "agentId" && value !== null ? BigInt(value) : value;
  }

  const fingerprint = JSON.stringify(next, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  if (applied !== null && applied !== fingerprint) {
    throw new Error(
      "BotID is already configured differently in this process. Each agent holds its own key, " +
        "so run one agent per process rather than reconfiguring a running one."
    );
  }
  applied = fingerprint;

  Object.assign(config, next);
  return config;
}

config.apply = apply;

module.exports = config;

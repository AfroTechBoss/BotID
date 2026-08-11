require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");

const fs = require("fs");
const path = require("path");

// A six-line .env reader rather than a dotenv dependency, matching relayer/src/config.js. Real
// environment variables win, so CI and a shell export both override the file rather than being
// silently replaced by it — the opposite order is how a deploy ends up signed by the wrong key.
const envFile = path.join(__dirname, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    process.env[key] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
}

/**
 * The ezkl verifier is generated next to the circuit that produced it, and Hardhat will not
 * import across the project boundary (HH408) — `contracts/` is the project, `circuits/` is not.
 * So a copy is kept inside the sources tree, and it is refreshed here rather than committed.
 *
 * Doing it at config load means `compile`, `test` and `run` all see the same file, which is the
 * property that matters: a stale verifier is a verifier bound to a verifying key the circuit no
 * longer has, and it fails by rejecting every honest proof rather than by failing to build. The
 * copy is gitignored so there is exactly one reviewable version, the one beside the circuit.
 *
 * Absent source is not an error. A clone that has not built the circuit still needs `test` and
 * `compile` to work; deploy.js is where its absence is fatal, and only when Gold is requested.
 */
function syncEzklVerifier() {
  const src = path.join(__dirname, "..", "circuits", "build", "Verifier.sol");
  const dest = path.join(__dirname, "src", "verifiers", "Halo2Verifier.sol");
  if (!fs.existsSync(src)) return;
  const banner =
    "// Generated — do not edit. Copied from circuits/build/Verifier.sol by hardhat.config.js.\n" +
    "// Edit the circuit and regenerate; edits here are overwritten on the next Hardhat command.\n";
  const next = banner + fs.readFileSync(src, "utf8");
  // Compared before writing so an unchanged verifier does not bump the mtime and invalidate the
  // whole compilation cache on every single command.
  if (fs.existsSync(dest) && fs.readFileSync(dest, "utf8") === next) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, next);
}
syncEzklVerifier();

/**
 * One key, read once, and shared by both networks.
 *
 * Returned as an empty list when unset rather than throwing, because `hardhat test`, `compile`
 * and every local task load this file too, and a config that cannot be required without a
 * production private key present is a config that pushes people toward keeping one lying around.
 * The failure then lands where it belongs: a deploy against a real network reports no signer.
 */
const accounts = process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY.trim()] : [];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  // The `compilers` array form rather than a bare `version`, because `overrides` is only read
  // alongside it — set next to a single `version` it is silently ignored, which looks exactly
  // like the override having no effect.
  solidity: {
    compilers: [
      {
        version: "0.8.24",
        settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true },
      },
    ],
    // The ezkl verifier is one long hand-written assembly block, and the IR pipeline cannot
    // compile it: Yul's stack scheduler gives up four slots deep inside the pairing check
    // ("Cannot swap Variable usr$gamma ... too deep in the stack"). It is generated code that
    // manages its own stack and gains nothing from IR anyway, so it is compiled the legacy way.
    // Everything the protocol itself ships still goes through viaIR — this is scoped to the one
    // generated file rather than relaxing the setting globally.
    overrides: {
      "src/verifiers/Halo2Verifier.sol": {
        version: "0.8.24",
        settings: { optimizer: { enabled: true, runs: 200 }, viaIR: false },
      },
    },
  },
  paths: {
    sources: "./src",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  // Chain ids and RPCs are from docs/architecture.md §7 and the frontend brief §20.1, both of
  // which record them as probed on 2026-08-09 rather than quoted. `chainId` is stated here so
  // that ethers checks it against the node on connect: an RPC silently pointed at the other
  // network is otherwise indistinguishable until the manifest is written with the wrong name.
  networks: {
    bohr: {
      url: process.env.BOHR_RPC_URL ?? "https://rpc.bohr.life",
      chainId: 968,
      accounts,
    },
    botchain: {
      url: process.env.BOTCHAIN_RPC_URL ?? "https://rpc.botchain.ai",
      chainId: 677,
      accounts,
    },
  },
  mocha: { timeout: 120000 },
};

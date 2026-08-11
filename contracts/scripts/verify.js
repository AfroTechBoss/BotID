// Publishes source for every contract in a deployment manifest.
//
//   npx hardhat run scripts/verify.js --network bohr
//
// Why a script and not eight `npx hardhat verify` lines: the constructor arguments are the part
// that goes wrong, and they are not guessable from the address. ExecutionRouter takes six, four of
// which are other contracts from the same deploy, and a single transposed pair — engine where the
// registry belongs — produces a bytecode mismatch whose error message says nothing about which
// argument was wrong. The manifest already records every one of those addresses. Reading them from
// it means the arguments cannot drift from what was actually deployed, which is the same reason
// the interface reads addresses from the manifest rather than from someone's notes.
//
// Verification changes nothing on chain. It uploads source, the explorer recompiles it, and it
// either matches the deployed bytecode or it does not. There is no transaction, no gas and no key
// involved — this is the one script here that is safe to re-run at will.

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const { chainId } = await hre.ethers.provider.getNetwork();
  const manifestPath = path.join(__dirname, "..", "deployments", `${hre.network.name}-${chainId}.json`);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`No manifest at ${path.relative(process.cwd(), manifestPath)}. Deploy first.`);
  }
  const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const c = m.contracts;
  const { owner, treasury } = m;

  // Mirrors the deploy order and the exact argument lists in deploy.js. If a constructor changes
  // there, it changes here — the two are a pair, and a comment is the only thing holding them
  // together, so keep them adjacent in review.
  const targets = [
    ["ReputationEngine", c.ReputationEngine, [owner]],
    ["AgentRegistry", c.AgentRegistry, [owner, c.bondToken, c.ReputationEngine, treasury]],
    ["InputAttestor", c.InputAttestor, [owner]],
    [
      "ExecutionRouter",
      c.ExecutionRouter,
      [owner, c.AgentRegistry, c.ReputationEngine, c.bondToken, c.InputAttestor, treasury],
    ],
    ["SignatureAdapter", c.SignatureAdapter, []],
    ["TeeAdapter", c.TeeAdapter, [owner]],
    ["ZkAdapter", c.ZkAdapter, [owner, c.InputAttestor]],
    ["Halo2Verifier", c.Halo2Verifier, []],
  ];
  // bondToken is deliberately absent: it is USDT, a pre-existing dependency we did not deploy.
  // Submitting our sources for someone else's contract would fail, and should.

  const results = [];
  for (const [name, address, args] of targets) {
    // A manifest from a deploy that skipped Gold has no ZkAdapter or Halo2Verifier. Absent is a
    // real state, not a broken manifest, so it is skipped rather than thrown on.
    if (!address) {
      results.push([name, "skipped", "not in this deployment"]);
      continue;
    }
    process.stdout.write(`${name} ${address} … `);
    try {
      await hre.run("verify:verify", { address, constructorArguments: args });
      console.log("verified");
      results.push([name, "verified", ""]);
    } catch (e) {
      const msg = (e && e.message) || String(e);
      // Already-verified is the expected outcome of a second run and of Blockscout's bytecode
      // database having got there first. Reporting it as a failure would train people to ignore
      // the failures that matter.
      if (/already verified|already been verified/i.test(msg)) {
        console.log("already verified");
        results.push([name, "already verified", ""]);
      } else {
        console.log("FAILED");
        results.push([name, "failed", msg.split("\n")[0]]);
      }
    }
  }

  console.log("\n--- summary ---");
  for (const [name, status, note] of results) {
    console.log(`  ${status.padEnd(16)} ${name}${note ? ` — ${note}` : ""}`);
  }
  const explorer = hre.config.etherscan.customChains.find((x) => x.network === hre.network.name);
  if (explorer) console.log(`\n${explorer.urls.browserURL}/address/${c.AgentRegistry}#code`);

  // Non-zero exit on any real failure, so this is usable in CI. "Already verified" is not one.
  if (results.some(([, status]) => status === "failed")) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

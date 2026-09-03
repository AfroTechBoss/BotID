/**
 * Add or remove an attestation publisher on a deployed InputAttestor.
 *
 *   PUBLISHER=0x… npx hardhat run scripts/set-publisher.js --network bohr
 *   PUBLISHER=0x… ALLOW=false npx hardhat run scripts/set-publisher.js --network botchain
 *
 * Arguments come through the environment because `hardhat run` consumes argv itself, which is the
 * same reason deploy.js is configured that way.
 *
 * This is the one piece of wiring that stayed cheap. setPublisher is plain onlyOwner with no
 * _consume guard, and InputAttestor has no finalizeBootstrap at all, so it sits outside the 21-day
 * timelock that setRouter, setWriter, setAdapter, setTreasury and setInputAttestor are behind. It
 * can be corrected on a live protocol in one transaction — which is worth knowing precisely
 * because almost nothing else here can.
 *
 * What a publisher can do is attest input readings. With quorum 1 — the setting on both current
 * deployments — one publisher is the whole feed and needs no second signature, so adding one is
 * not a partial grant. Read the quorum this prints before adding anybody on mainnet.
 */

const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

async function main() {
  const raw = process.env.PUBLISHER;
  if (!raw) throw new Error("set PUBLISHER to the address to add or remove");
  const publisher = ethers.getAddress(raw.trim());

  // Default to adding, because removing is the rarer intent and should be typed.
  const allow = (process.env.ALLOW ?? "true").toLowerCase() !== "false";

  const chainId = (await ethers.provider.getNetwork()).chainId;
  const file = path.join(__dirname, "..", "deployments", `${network.name}-${chainId}.json`);
  if (!fs.existsSync(file)) throw new Error(`no manifest at ${file}`);
  const m = JSON.parse(fs.readFileSync(file, "utf8"));

  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("no signer — PRIVATE_KEY is not set for this network");

  const attestor = await ethers.getContractAt("InputAttestor", m.contracts.InputAttestor);
  const [owner, quorum, current] = await Promise.all([
    attestor.owner(),
    attestor.quorum(),
    attestor.publishers(publisher),
  ]);

  console.log(`network      ${network.name} (${chainId})`);
  console.log(`attestor     ${await attestor.getAddress()}`);
  console.log(`owner        ${owner}`);
  console.log(`quorum       ${quorum} signature(s) per reading`);
  console.log(`publisher    ${publisher} — currently ${current}, requested ${allow}`);

  // Checked here rather than left to the revert, so the failure names the key that would have
  // been needed instead of returning an unowned-selector error.
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`signer ${signer.address} is not the owner — this must be sent from ${owner}`);
  }

  if (current === allow) {
    console.log(`\nAlready ${allow}. Nothing to send.`);
    return;
  }

  const tx = await attestor.setPublisher(publisher, allow);
  const receipt = await tx.wait();
  console.log(`\nsent         ${tx.hash} in block ${receipt.blockNumber}`);

  // Read back rather than trusting the receipt.
  console.log(`readback     publishers(${publisher}) = ${await attestor.publishers(publisher)}`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exitCode = 1;
});

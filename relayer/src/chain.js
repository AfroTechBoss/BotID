const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const config = require("./config");

/** Load an ABI out of the Hardhat artifact tree without depending on Hardhat itself. */
function abiOf(name) {
  const stack = [config.artifactsDir];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === `${name}.json`) return JSON.parse(fs.readFileSync(full, "utf8")).abi;
    }
  }
  throw new Error(`no artifact for ${name} under ${config.artifactsDir} — compile the contracts first`);
}

async function connect({ key } = {}) {
  const manifest = config.manifest();
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const chainId = (await provider.getNetwork()).chainId;

  if (BigInt(manifest.chainId) !== chainId) {
    throw new Error(`manifest is for chain ${manifest.chainId} but RPC reports ${chainId}`);
  }

  const signer = key ? new ethers.Wallet(key, provider) : null;
  const at = (name, addrKey) =>
    new ethers.Contract(manifest.contracts[addrKey ?? name], abiOf(name), signer ?? provider);

  const contracts = {
    registry: at("AgentRegistry"),
    router: at("ExecutionRouter"),
    engine: at("ReputationEngine"),
    attestor: at("InputAttestor"),
    token: at("MockERC20", "bondToken"), // ABI is plain ERC-20; any bond token answers it
    sigAdapter: at("SignatureAdapter"),
    teeAdapter: at("TeeAdapter"),
    zkAdapter: manifest.contracts.ZkAdapter ? at("ZkAdapter") : null,
  };

  // The relayer's digests are hand-written mirrors of the Solidity. If a contract is ever
  // redeployed with a different typehash, every signature produced here becomes silently
  // invalid — so check it once at startup rather than discovering it in a failed deliver().
  const { EXECUTION_TYPEHASH, FEED_TYPEHASH } = require("./digest");
  const onChainFeedTypehash = await contracts.attestor.FEED_TYPEHASH();
  if (onChainFeedTypehash.toLowerCase() !== FEED_TYPEHASH.toLowerCase()) {
    throw new Error("FEED_TYPEHASH mismatch between relayer and deployed InputAttestor");
  }
  void EXECUTION_TYPEHASH; // Digest is a library, so its typehash has no on-chain getter.

  return { manifest, provider, signer, chainId, contracts };
}

module.exports = { connect, abiOf };

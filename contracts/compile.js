// Minimal solc driver — verifies the contract set compiles without pulling in a full framework.
// Usage: node compile.js
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const SRC = path.join(__dirname, "src");

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".sol")) out.push(full);
  }
  return out;
}

const sources = {};
for (const file of walk(SRC)) {
  const key = path.relative(SRC, file).split(path.sep).join("/");
  sources[key] = { content: fs.readFileSync(file, "utf8") };
}

const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    viaIR: true,
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};

function findImport(importPath) {
  const candidate = path.join(SRC, importPath);
  if (fs.existsSync(candidate)) return { contents: fs.readFileSync(candidate, "utf8") };
  return { error: "File not found: " + importPath };
}

const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImport }));

let failed = false;
for (const err of output.errors ?? []) {
  if (err.severity === "error") failed = true;
  console.log(err.formattedMessage);
}

if (!failed) {
  const names = [];
  for (const [file, contracts] of Object.entries(output.contracts ?? {})) {
    for (const [name, c] of Object.entries(contracts)) {
      const size = (c.evm.bytecode.object.length / 2) | 0;
      if (size > 0) names.push(`${name.padEnd(20)} ${String(size).padStart(6)} bytes  (${file})`);
    }
  }
  console.log("\nCompiled OK\n");
  console.log(names.sort().join("\n"));
}

process.exit(failed ? 1 : 0);

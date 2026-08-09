#!/usr/bin/env node
const { log } = require("./util");

const USAGE = `
botid relayer

  node src/index.js agent
      Run the agent-side relayer: deliver work addressed to AGENT_ID and defend it
      against challenges. Needs OPERATOR_KEY.

  node src/index.js watchtower
      Run the permissionless keeper: markExpired, finalize, slashUnresolvedChallenge,
      settleDefault. Needs WATCHTOWER_KEY.

  node src/index.js consumer request  --agent <id> [--notional N] [--fee N] [--window secs]
                                      [--feeds A,B,C] [--values 12500,34000,4200]
  node src/index.js consumer settle   --request <id> [--pnl bps] [--sla true] [--limit true]
  node src/index.js consumer challenge --request <id>
  node src/index.js consumer watch    --request <id>
      Drive the consumer side. Needs CONSUMER_KEY (or CHALLENGER_KEY to challenge).

Configuration is read from relayer/.env; see .env.example.
`;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    out[key] = next && !next.startsWith("--") ? (i++, next) : "true";
  }
  return out;
}

async function main() {
  const [command, sub, ...rest] = process.argv.slice(2);
  const args = parseArgs([sub, ...rest].filter(Boolean));

  switch (command) {
    case "agent":
      return require("./agent").run();
    case "watchtower":
      return require("./watchtower").run();
    case "consumer": {
      const consumer = require("./consumer");
      const fn = consumer[sub];
      if (!fn) throw new Error(`unknown consumer command: ${sub ?? "(none)"}`);
      return fn(args);
    }
    default:
      console.log(USAGE);
      process.exitCode = command ? 1 : 0;
  }
}

main().catch((e) => {
  log.error(e.shortMessage ?? e.message);
  if (process.env.DEBUG) console.error(e);
  process.exitCode = 1;
});

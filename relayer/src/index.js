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

  node src/index.js alerts
      Run the alert daemon: follow faults, challenges and unbondings, sweep watched
      scores for threshold crossings, and POST a signed webhook for each. Holds no
      key. Needs DATABASE_URL (the direct string) and the pg package.

  node src/index.js arena [run|order|settle|once|status]
      Run the Arena: the first-party consumer. Discovers registered agents, orders work
      from them on a schedule with real market data, holds the allocation, then settles
      with what it actually returned. Needs CONSUMER_KEY and PUBLISHER_KEY.
      "order" and "settle" run one loop each, so they can be restarted separately;
      "once" does a single pass of both, for cron. See docs/arena.md.

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
    case "alerts":
      return require("./alerts").run();
    case "arena": {
      const arena = require("./arena");
      if (sub === "status") return arena.status();
      if (sub === "once") return arena.once();
      if (sub === "order" || sub === "settle") return arena.run({ mode: sub });
      if (sub === undefined || sub === "run") return arena.run();
      throw new Error(`unknown arena command: ${sub}`);
    }
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

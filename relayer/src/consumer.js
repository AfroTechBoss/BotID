const { ethers } = require("ethers");
const config = require("./config");
const { connect } = require("./chain");
const publisher = require("./publisher");
const { log, sleep } = require("./util");

/**
 * Demo consumer — the party a real integration (a vault, a strategy manager) would be.
 *
 * It exists to exercise the two things a consumer is uniquely responsible for, both of which
 * are load-bearing for the protocol's honesty:
 *
 *   1. It picks the inputs. The agent must never be able to choose the data it is graded on,
 *      so the consumer assembles the publisher-signed bundle and commits to it on chain.
 *   2. It reports the outcome. Reputation is built from settled economic results, not from
 *      proof validity, so `settle` is where the signal actually enters the system.
 *
 * Usage:
 *   node src/index.js consumer request --agent 1 --notional 100000 --fee 100
 *   node src/index.js consumer settle  --request 0x… --pnl -120
 */
async function request(args) {
  const key = config.required("CONSUMER_KEY");
  const { manifest, provider, signer, chainId, contracts } = await connect({ key });

  const agentId = BigInt(args.agent ?? config.required("AGENT_ID"));
  const notional = ethers.parseEther(String(args.notional ?? 100_000));
  // The router refuses a zero-notional request: it would be a live obligation the registry's
  // early-exit gate cannot see, since that gate reads `openNotional`. Caught here so the answer
  // is a sentence rather than a bare custom error out of a revert.
  if (notional === 0n) {
    throw new Error("--notional must be greater than zero; a request with nothing at risk is refused");
  }
  // Seconds the agent has to deliver. The router enforces a floor — a deadline no operator
  // could meet is how an agent gets slashed for a job it never had a chance at — so read it off
  // the chain and clamp rather than hardcoding a number that a governance change would silently
  // turn into a revert. The margin covers the seconds between reading `ts` and the tx mining.
  const floor = Number(await contracts.router.minDeliveryWindow());
  const requested = Number(args.window ?? 900);
  const window = Math.max(requested, floor + 60);
  if (window !== requested) {
    log.warn(`window ${requested}s is below the router's ${floor}s floor - using ${window}s`);
  }

  // The router enforces a floor of `minFeeBps` of notional, so a consumer that names no fee
  // pays exactly the minimum rather than reverting on a hardcoded default.
  const minFeeBps = await contracts.router.minFeeBps();
  const fee = args.fee
    ? ethers.parseEther(String(args.fee))
    : (notional * minFeeBps) / 10_000n;

  // Assemble the inputs. In production these readings come from an independent publisher's
  // API already signed; here the seed script's publisher key stands in for that network.
  const pubKey = manifest.seeded?.publisher?.privateKey ?? config.required("PUBLISHER_KEY");
  const pub = new publisher.Publisher(pubKey, chainId, manifest.contracts.InputAttestor);

  const ts = (await provider.getBlock("latest")).timestamp;

  // Values are whole numbers at the model's declared decimal scale — the reference allocator's
  // `decimals` is 100, so these are cents. `--values` overrides them; without it the demo picks
  // a spread that puts some feeds above the mean and some below, which is the only thing the
  // reference model reacts to.
  const names = (args.feeds ?? "BOT/USD,ETH/USD,BTC/USD").split(",").map((s) => s.trim());
  const values = args.values
    ? String(args.values).split(",").map((v) => BigInt(v.trim()))
    : [12_500n, 34_000n, 4_200n];
  if (values.length !== names.length) {
    throw new Error(`${names.length} feeds but ${values.length} values`);
  }

  // The salt is what keeps the reading private between the request and the reveal. An input
  // commitment is public from the moment `requestExecution` lands, so an unsalted value is a
  // published price — and the agent could read its own inputs out of the commitment.
  const readings = names.map((name, i) => ({
    feedId: ethers.id(name),
    value: values[i],
    salt: publisher.newSalt(),
    timestamp: ts,
  }));

  const { bundle, commitment } = publisher.buildBundle(
    chainId,
    manifest.contracts.InputAttestor,
    readings,
    [pub]
  );

  // Publish the bundle where the agent can fetch it, and pass the locator in the event. The
  // commitment is the authority; the URI is only a convenience, and the agent re-checks it.
  // The readings ride along with the bundle. They are not authority — the agent re-checks every
  // one of them against the committed `valueHash` — but without them the agent has hashes it
  // cannot run a model on, and nothing to reveal if the delivery is ever challenged.
  const name = `bundle-${commitment.slice(2, 12)}`;
  const file = publisher.writeBundle(name, {
    commitment,
    bundle,
    readings: readings.map((r) => ({ ...r, value: r.value.toString() })),
  });

  const token = contracts.token.connect(signer);
  if ((await token.allowance(signer.address, manifest.contracts.ExecutionRouter)) < fee) {
    await (await token.approve(manifest.contracts.ExecutionRouter, ethers.MaxUint256)).wait();
  }

  const tx = await contracts.router.requestExecution(
    agentId,
    commitment,
    notional,
    fee,
    ts + window,
    name
  );
  const receipt = await tx.wait(config.confirmations);
  const ev = receipt.logs
    .map((l) => {
      try {
        return contracts.router.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((e) => e && e.name === "ExecutionRequested");

  log.info(`requested ${ev.args.requestId}`);
  log.info(`  agent      ${agentId}`);
  log.info(`  fee        ${ethers.formatEther(fee)} (floor ${minFeeBps} bps of notional)`);
  log.info(`  inputs     ${commitment} (${file})`);
  log.info(`  deliverBy  ${new Date((ts + window) * 1000).toISOString()}`);
  return ev.args.requestId;
}

/**
 * Report the economic result. `realizedPnlBps` is signed; `slaBreached` and `limitBreached` are
 * the consumer's own judgement of whether the agent stayed inside its mandate. Note the
 * asymmetry the scoring enforces: profit is not rewarded, breaches are punished. A consumer
 * cannot inflate an agent by reporting spectacular returns.
 */
async function settle(args) {
  const key = config.required("CONSUMER_KEY");
  const { contracts } = await connect({ key });

  const requestId = args.request ?? config.required("REQUEST_ID");
  const outcome = {
    realizedPnlBps: BigInt(args.pnl ?? 0),
    slaBreached: args.sla === "true",
    limitBreached: args.limit === "true",
  };

  const tx = await contracts.router.settle(requestId, outcome);
  await tx.wait(config.confirmations);

  const r = await contracts.router.getRequest(requestId);
  const score = await contracts.engine.getScore(r.agentId);
  log.info(`settled ${requestId} - agent ${r.agentId} score is now ${score}`);
}

/** Post a challenge bond against a delivery, forcing the agent to prove it at Gold. */
async function challenge(args) {
  const key = config.required("CHALLENGER_KEY");
  const { manifest, contracts, signer } = await connect({ key });

  const requestId = args.request ?? config.required("REQUEST_ID");
  const amount = await contracts.router.challengeBondAmount();
  const token = contracts.token.connect(signer);
  if ((await token.allowance(signer.address, manifest.contracts.ExecutionRouter)) < amount) {
    await (await token.approve(manifest.contracts.ExecutionRouter, ethers.MaxUint256)).wait();
  }

  await (await contracts.router.challenge(requestId)).wait(config.confirmations);
  log.info(`challenged ${requestId} - the agent must now answer with a Gold proof`);
}

/** Watch a request through to a terminal state. Convenient for driving the local demo. */
async function watch(args) {
  const { contracts } = await connect();
  const requestId = args.request ?? config.required("REQUEST_ID");
  const names = ["None", "Pending", "Delivered", "Challenged", "Finalized", "Settled", "Expired", "Faulted", "Rejected"];
  let last = null;
  for (;;) {
    const r = await contracts.router.getRequest(requestId);
    const s = Number(r.status);
    if (s !== last) {
      log.info(`${requestId} -> ${names[s]}`);
      last = s;
    }
    if ([0, 5, 6, 7].includes(s)) return;
    await sleep(2000);
  }
}

module.exports = { request, settle, challenge, watch };

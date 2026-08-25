const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const config = require("../config");
const { connect } = require("../chain");
const publisher = require("../publisher");
const { loadRunner } = require("../inference");
const { log, sleep, retry } = require("../util");
const market = require("./market");
const score = require("./score");
const ledger = require("./ledger");
const discovery = require("./discovery");

/**
 * BotID Arena — the protocol's first-party consumer.
 *
 * A registered agent is a shop with the lights on and the door locked: a name, a bond in the
 * till, a sign in the window, and no evidence of anything until a customer walks in. Nothing in
 * the protocol hires anybody. The Arena is the customer — it finds every registered agent,
 * orders work on a schedule, supplies the input data itself, and then reports what that work
 * was actually worth.
 *
 * It is also the first configuration on this deployment where the party grading the work is not
 * the party that did it. That is worth more than the volume.
 *
 * ---------------------------------------------------------------------------------------
 * Two loops, not one
 *
 * The obvious shape — order, wait, settle — is wrong for the same reason a restaurant does not
 * seat one table at a time. The protocol forces a wait between the two halves: `deliverBy`, then
 * a challenge window before `finalizeAt`, then the hold this file adds on top before the answer
 * can be graded at all. A single loop would spend its life asleep.
 *
 *   order loop    discover -> filter -> snapshot the market -> requestExecution -> write a row
 *   settle loop   read rows -> is it Finalized and held long enough? -> grade it -> settle
 *
 * They share a file and nothing else, so either can be restarted, and they fail for genuinely
 * different reasons: the order loop dies when the fee budget runs out, the settle loop when the
 * price source is down. Collapsing them would mean one failure stops both — and a stalled settle
 * loop holding its own agents' exposure hostage is precisely the situation `settleDefault`
 * exists to break.
 *
 * ---------------------------------------------------------------------------------------
 * What this deliberately does not do
 *
 * It never calls `finalize`, `markExpired`, `slashUnresolvedChallenge` or `settleDefault`. Those
 * are the watchtower's, they are permissionless, and two processes racing to pay gas for the
 * same state transition is not redundancy. **The watchtower is therefore a hard dependency**:
 * with none running, deliveries never reach `Finalized`, the settle loop never has anything to
 * grade, and the Arena looks broken for a reason that has nothing to do with the Arena.
 *
 * It never challenges either. A consumer that both commissions work and disputes it is grading
 * with a thumb on the scale in the other direction.
 */

const Status = {
  None: 0, Pending: 1, Delivered: 2, Challenged: 3,
  Finalized: 4, Settled: 5, Expired: 6, Faulted: 7,
};
const TERMINAL = new Set([Status.None, Status.Settled, Status.Expired, Status.Faulted]);

// ------------------------------------------------------------------ startup checks

/**
 * Refuse to start on a configuration that can only produce garbage.
 *
 * Every one of these is something that otherwise surfaces hours later as an unexplained revert
 * or, worse, as a settled number nobody should have trusted. The windows are read from the
 * deployed router rather than assumed: they are owner-settable, and a hold that has drifted
 * outside them is the difference between grading an agent and letting `settleDefault` grade it
 * at par on the Arena's behalf.
 */
async function preflight(contracts) {
  const a = config.arena;

  const challengeWindow = Number(await contracts.router.challengeWindow());
  const settlementWindow = Number(await contracts.router.settlementWindow());
  const holdSec = a.holdHours * 3600;

  if (holdSec <= challengeWindow) {
    throw new Error(
      `ARENA_HOLD_HOURS=${a.holdHours} is inside the router's ${challengeWindow}s challenge ` +
        "window — the request cannot be Finalized yet, so every settle would revert"
    );
  }
  if (holdSec >= settlementWindow) {
    throw new Error(
      `ARENA_HOLD_HOURS=${a.holdHours} exceeds the router's ${settlementWindow}s settlement ` +
        "window — a watchtower would settleDefault at par before the hold expired, which is " +
        "reporting zero with extra steps"
    );
  }
  if (a.deliverWindowSec <= 0) throw new Error("ARENA_DELIVER_WINDOW_SEC must be positive");
  if (a.notionalBps <= 0 || a.notionalBps > 10_000) {
    throw new Error("ARENA_NOTIONAL_BPS must be in 1..10000 — it is a fraction of a credit line");
  }

  // The feed count is part of the model's identity, not a preference. Checked against the
  // circuit spec when there is one to check against; a mismatch produces bundles no agent can
  // run, and it does so quietly.
  const spec = readSpec();
  if (spec && spec.feeds !== a.assets.length) {
    throw new Error(
      `ARENA_ASSETS has ${a.assets.length} entries but ${spec.name} takes ${spec.feeds} feeds — ` +
        "the feed count is part of the model commitment, so this is a different model"
    );
  }

  if (!a.bundleBaseUrl) {
    log.warn(
      "no ARENA_BUNDLE_BASE_URL — bundles are addressed by bare name, which only resolves for " +
        "an agent sharing this filesystem. Remote agents will fail to fetch their inputs."
    );
  }
  return { challengeWindow, settlementWindow };
}

function readSpec() {
  try {
    return JSON.parse(fs.readFileSync(path.join(config.circuitsDir, "spec.json"), "utf8"));
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ the order loop

/**
 * Commission one job from one agent.
 *
 * The readings are salted per value, and the reason is the same one `consumer.js` gives: the
 * input commitment is public from the instant `requestExecution` lands, so an unsalted reading
 * is a published price. The salt is the sealed envelope around the exam paper — it does not
 * hide the paper from the candidate, who is handed it openly at the URI, it stops everyone else
 * reading the questions off the outside of the envelope.
 *
 * The entry prices ride along in the published bundle file. They are not part of the commitment
 * — the attestor commits to feed readings and nothing else — but publishing them at order time,
 * before anybody knows what the market will do, is most of what committing to them would buy.
 * An agent that disputes its score can check the Arena graded it against the tape it announced.
 */
async function order(ctx, agent, snapshot) {
  const { manifest, chainId, signer, contracts, pub } = ctx;
  const a = config.arena;

  const nowSec = snapshot.at;
  const deliverBy = nowSec + a.deliverWindowSec;
  const notional = BigInt(agent.notional);

  const minFeeBps = await contracts.router.minFeeBps();
  const fee = (notional * BigInt(minFeeBps)) / 10_000n;

  const readings = snapshot.rows.map((row) => ({
    feedId: ethers.id(row.asset),
    value: row.value,
    salt: publisher.newSalt(),
    timestamp: nowSec,
  }));

  const { bundle, commitment } = publisher.buildBundle(
    chainId,
    manifest.contracts.InputAttestor,
    readings,
    [pub]
  );

  const name = `arena-${commitment.slice(2, 12)}`;
  publisher.writeBundle(name, {
    commitment,
    bundle,
    readings: readings.map((r) => ({ ...r, value: r.value.toString() })),
    // Not authority, and not what the agent runs on. Published so the grading is auditable.
    arena: {
      assets: snapshot.rows.map((r) => r.asset),
      entry: snapshot.rows.map((r) => market.formatPrice(r.price)),
      reference: snapshot.rows.map((r) => market.formatPrice(r.reference)),
      lookbackHours: snapshot.lookbackHours,
      holdHours: a.holdHours,
      source: snapshot.source,
    },
  });
  const inputURI = a.bundleBaseUrl ? `${a.bundleBaseUrl.replace(/\/$/, "")}/${name}.json` : name;

  const token = contracts.token.connect(signer);
  if ((await token.allowance(signer.address, manifest.contracts.ExecutionRouter)) < fee) {
    await (await token.approve(manifest.contracts.ExecutionRouter, ethers.MaxUint256)).wait();
  }

  const tx = await retry(
    () =>
      contracts.router.requestExecution(
        agent.agentId, commitment, notional, fee, deliverBy, inputURI
      ),
    { attempts: 3, label: `requestExecution agent ${agent.agentId}` }
  );
  const receipt = await tx.wait(config.confirmations);
  const ev = receipt.logs
    .map((l) => { try { return contracts.router.interface.parseLog(l); } catch { return null; } })
    .find((e) => e && e.name === "ExecutionRequested");
  if (!ev) throw new Error("requestExecution produced no ExecutionRequested log");

  const requestId = ev.args.requestId;
  ledger.record({
    requestId,
    agentId: String(agent.agentId),
    modelCommitment: agent.modelCommitment,
    tier: agent.tier,
    lossToleranceBps: agent.lossToleranceBps,
    orderedAt: nowSec,
    deliverBy,
    holdUntil: nowSec + a.holdHours * 3600,
    notional,
    fee,
    inputURI,
    commitment,
    assets: snapshot.rows.map((r) => r.asset),
    entry: snapshot.rows.map((r) => r.price),
    readings: readings.map((r) => ({ feedId: r.feedId, value: r.value, salt: r.salt, timestamp: r.timestamp })),
    priceSource: snapshot.source,
  });

  log.info(
    `ordered ${requestId} | agent ${agent.agentId} | notional ${notional} | fee ${fee} | ` +
      `grade after ${new Date((nowSec + a.holdHours * 3600) * 1000).toISOString()}`
  );
  return requestId;
}

async function orderPass(ctx) {
  const a = config.arena;

  const ids = await discovery.allAgentIds(ctx.contracts, ctx.provider);
  if (ids.length === 0) {
    log.info("no agents registered yet — nothing to hire");
    return;
  }

  const agents = await discovery.readAgents(ctx.contracts, ids);
  const { picked, skipped } = discovery.eligible(agents, {
    busy: ledger.busyAgents(),
    lastOrdered: ledger.lastOrderedAt(),
    nowSec: Math.floor(Date.now() / 1000),
    cooldownSec: a.cooldownSec,
    notionalBps: a.notionalBps,
  });

  if (picked.length === 0) {
    log.info(`${agents.length} agents, none eligible: ${skipped.map((s) => `${s.agentId} ${s.why}`).join("; ")}`);
    return;
  }

  // One market read for the whole pass. Every agent in this batch is then graded against the
  // same instant, which is the only version where comparing two agents' scores is fair — a
  // batch priced agent by agent would rank whoever happened to be quoted in a calmer minute.
  const snapshot = await market.snapshot({
    assets: a.assets,
    lookbackHours: a.lookbackHours,
  });
  log.info(
    `market ${snapshot.source} | ` +
      snapshot.rows.map((r) => `${r.asset} ${market.formatPrice(r.price)} idx ${r.value}`).join(" | ")
  );

  const budget = a.feeBudget === null ? null : ethers.parseUnits(String(a.feeBudget), ctx.decimals);
  for (const agent of picked) {
    if (budget !== null) {
      const spent = ledger.feesSpent();
      const next = (BigInt(agent.notional) * BigInt(await ctx.contracts.router.minFeeBps())) / 10_000n;
      if (spent + next > budget) {
        log.warn(`fee budget reached (${spent} of ${budget}) — ordering paused`);
        return;
      }
    }
    try {
      await order(ctx, agent, snapshot);
    } catch (e) {
      log.error(`order for agent ${agent.agentId} failed: ${e.shortMessage ?? e.message}`);
    }
  }
}

// ------------------------------------------------------------------ the settle loop

/**
 * Recover the allocation the agent committed to.
 *
 * Only `outputCommitment` — a single hash — ever goes on chain. `deliver` takes the outputs,
 * hashes them and stores the hash; the numbers themselves stay in the agent's memory and are
 * never published anywhere. So the Arena cannot read the allocation it is supposed to grade.
 * It has to *reconstruct* it.
 *
 * Which it can, because it holds every input: it wrote the readings, the model commitment is on
 * the agent's registration, and the runner is the same one the agent used. Re-run the model,
 * hash the outputs the same way `ZkAdapter.outputCommitmentFor` does, and compare. A match
 * proves two things at once — that these are the weights, and that the agent really did run the
 * model it claims to run. Marking the exam by working the problem yourself and checking that
 * the sealed answer matches.
 *
 * A mismatch is not a grading failure, it is a finding: the agent delivered something other than
 * this model's answer on these inputs. The Arena reports rather than punishes — it does not
 * challenge, per the header — but the note lands in the ledger where it can be argued with.
 */
async function recoverWeights(ctx, row, request) {
  const runner = await runnerFor(ctx, row.modelCommitment);
  if (!runner) return { weights: null, why: `no runner for model ${row.modelCommitment}` };

  const reveals = row.readings.map((r) => ({
    feedId: r.feedId,
    timestamp: r.timestamp,
    value: BigInt(r.value),
    salt: r.salt,
  }));

  // Both arguments are the reveals. A runner takes `(feeds, reveals)` because the agent has the
  // bundle's hashed feeds to hand and the opened values separately; the Arena wrote both halves
  // itself, so here they are the same list and only the second one is ever read.
  const { weights, outputCommitment } = await runner.run(reveals, reveals);
  if (outputCommitment.toLowerCase() !== String(request.outputCommitment).toLowerCase()) {
    return {
      weights: null,
      why:
        `delivered outputCommitment ${request.outputCommitment} is not this model's answer on ` +
        `these inputs (${outputCommitment})`,
    };
  }
  return { weights: weights.map((w) => BigInt(w)) };
}

const runners = new Map();

/**
 * A runner for a model commitment, cached.
 *
 * `loadRunner` honours MODEL_RUNNER exactly as the agent's does, which is the point — grading
 * with a different implementation than the one being graded is how two honest parties end up
 * disagreeing about the last digit. A model the Arena cannot run is cached as `null`: an agent
 * on a foreign model is a permanent condition, not a transient one, and re-deriving that every
 * five minutes for the life of the process is noise.
 */
async function runnerFor(ctx, modelCommitment) {
  const key = String(modelCommitment).toLowerCase();
  if (runners.has(key)) return runners.get(key);

  let runner = null;
  try {
    let scaleBits = 0;
    if (ctx.contracts.zkAdapter) {
      const model = await ctx.contracts.zkAdapter.modelFor(modelCommitment);
      scaleBits = Number(model.inputScaleBits);
    }
    runner = loadRunner(modelCommitment, scaleBits);
  } catch (e) {
    log.warn(`cannot grade model ${modelCommitment}: ${e.shortMessage ?? e.message}`);
    runner = null;
  }
  runners.set(key, runner);
  return runner;
}

/** Grade one held request and report it. */
async function settleOne(ctx, row, request) {
  const { weights, why } = await recoverWeights(ctx, row, request);
  if (!weights) {
    // Deliberately not settled. The alternative — reporting a number the Arena cannot stand
    // behind — is the one thing this whole design exists to avoid, and a watchtower will
    // settle it at par once `settleBy` lapses. Losing the sample is the correct price.
    log.error(`${row.requestId} ungradeable: ${why}`);
    ledger.close(row.requestId, null, `ungradeable: ${why}`);
    return;
  }

  const exit = await market.exitPrices({ assets: row.assets });
  const entry = row.entry.map(BigInt);
  const exitPrices = row.assets.map((asset) => {
    const found = exit.rows.find((r) => r.asset === asset);
    if (!found) throw new Error(`no exit price for ${asset}`);
    return found.price;
  });

  const outcome = score.outcomeFor({
    weights,
    entry,
    exit: exitPrices,
    deliveredAt: Number(request.finalizeAt) || undefined,
    deliverBy: Number(request.deliverBy),
  });
  const legs = score.explain(row.assets, weights, entry, exitPrices);

  const tx = await retry(
    () => ctx.contracts.router.settle(row.requestId, outcome),
    { attempts: 3, label: `settle ${row.requestId}` }
  );
  await tx.wait(config.confirmations);

  const after = await ctx.contracts.engine.getScore(row.agentId);
  ledger.close(row.requestId, outcome, "settled");
  ledger.update(row.requestId, { legs, exitAt: exit.at, scoreAfter: Number(after) });

  log.info(
    `settled ${row.requestId} | agent ${row.agentId} | pnl ${outcome.realizedPnlBps}bps ` +
      `(tolerance ${row.lossToleranceBps}bps) | score now ${after}`
  );
  for (const leg of legs) {
    log.info(`    ${leg.asset} ${leg.weightBps}bps @ ${leg.entry} -> ${leg.exit} = ${leg.contributionBps}bps`);
  }
}

async function settlePass(ctx) {
  const rows = ledger.open();
  if (rows.length === 0) return;

  const nowSec = Math.floor(Date.now() / 1000);

  for (const row of rows) {
    try {
      const request = await ctx.contracts.router.getRequest(row.requestId);
      const status = Number(request.status);

      if (TERMINAL.has(status)) {
        // Somebody else ended it: expired, faulted, or settled at par past `settleBy`. All
        // three are legitimate outcomes and none of them is the Arena's to redo.
        ledger.close(row.requestId, null, `closed by chain in status ${status}`);
        log.info(`${row.requestId} closed — status ${status}`);
        continue;
      }
      if (status !== Status.Finalized) continue; // the watchtower's phase, not ours
      if (nowSec < Number(row.holdUntil)) continue; // still being held

      if (nowSec > Number(request.settleBy)) {
        ledger.close(row.requestId, null, "missed settleBy — a watchtower will settle at par");
        log.warn(`${row.requestId} passed settleBy before it could be graded`);
        continue;
      }

      await settleOne(ctx, row, request);
    } catch (e) {
      // Left open on purpose. A price source that is down comes back, and settling late but
      // correctly beats settling now with a number nobody should trust.
      log.error(`settle ${row.requestId} failed: ${e.shortMessage ?? e.message}`);
    }
  }
}

// ------------------------------------------------------------------ entrypoints

async function context() {
  const key = config.required("CONSUMER_KEY");
  const ctx = await connect({ key });
  const windows = await preflight(ctx.contracts);

  const pubKey = ctx.manifest.seeded?.publisher?.privateKey ?? config.required("PUBLISHER_KEY");
  const pub = new publisher.Publisher(pubKey, ctx.chainId, ctx.manifest.contracts.InputAttestor);
  const decimals = Number(await ctx.contracts.token.decimals());

  log.info(
    `arena online | consumer ${ctx.signer.address} | publisher ${pub.address} | ` +
      `assets ${config.arena.assets.join(",")} | lookback ${config.arena.lookbackHours}h | ` +
      `hold ${config.arena.holdHours}h (challenge ${windows.challengeWindow}s, settle ${windows.settlementWindow}s)`
  );
  log.info(`ledger ${ledger.file()}`);

  return { ...ctx, pub, decimals };
}

/** `mode` is "order", "settle" or "both". Both runs them as independent loops in one process. */
async function run({ mode = "both" } = {}) {
  const ctx = await context();
  const a = config.arena;

  const loop = async (label, pass, intervalMs) => {
    for (;;) {
      try {
        await pass(ctx);
      } catch (e) {
        log.error(`${label} pass failed: ${e.shortMessage ?? e.message}`);
      }
      await sleep(intervalMs);
    }
  };

  const running = [];
  if (mode !== "settle") running.push(loop("order", orderPass, a.orderIntervalMs));
  if (mode !== "order") running.push(loop("settle", settlePass, a.settleIntervalMs));
  await Promise.all(running);
}

/** One pass of each, then exit. For cron, and for seeing what a pass would do. */
async function once({ mode = "both" } = {}) {
  const ctx = await context();
  if (mode !== "settle") await orderPass(ctx);
  if (mode !== "order") await settlePass(ctx);
}

/** What the order loop can see, without ordering anything. */
async function status() {
  const ctx = await context();
  const ids = await discovery.allAgentIds(ctx.contracts, ctx.provider);
  const agents = await discovery.readAgents(ctx.contracts, ids);
  const { picked, skipped } = discovery.eligible(agents, {
    busy: ledger.busyAgents(),
    lastOrdered: ledger.lastOrderedAt(),
    nowSec: Math.floor(Date.now() / 1000),
    cooldownSec: config.arena.cooldownSec,
    notionalBps: config.arena.notionalBps,
  });

  log.info(`${agents.length} agents registered`);
  for (const p of picked) {
    log.info(`  eligible  agent ${p.agentId} tier ${p.tier} score ${p.score} notional ${p.notional}`);
  }
  for (const s of skipped) log.info(`  skipped   agent ${s.agentId} — ${s.why}`);

  const open = ledger.open();
  log.info(`${open.length} open Arena jobs, ${ledger.feesSpent()} spent in fees`);
  for (const row of open) {
    const r = await ctx.contracts.router.getRequest(row.requestId);
    log.info(
      `  ${row.requestId} agent ${row.agentId} status ${Number(r.status)} ` +
        `grade after ${new Date(Number(row.holdUntil) * 1000).toISOString()}`
    );
  }
}

module.exports = { run, once, status, orderPass, settlePass, preflight, Status };

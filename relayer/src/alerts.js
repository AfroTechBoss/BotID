const crypto = require("node:crypto");
const dns = require("node:dns/promises");
const net = require("node:net");
const config = require("./config");
const { connect } = require("./chain");
const { log, sleep } = require("./util");
const { isPrivateAddress } = require("./publisher");

/**
 * The alert daemon.
 *
 * It watches the chain on behalf of people who are not watching it, and posts a webhook when
 * something they subscribed to happens. Subscriptions arrive through a Postgres table that the
 * interface writes (db/001_alerts.sql, interface/app/api/alerts/route.ts) — not through an HTTP
 * endpoint here, because this process runs beside the watchtower on a host that should accept no
 * inbound connections at all.
 *
 * It holds no key. Everything it does is a read, a select and an outbound POST; there is no
 * transaction it could send if it were compromised, which is the whole reason it is a separate
 * mode rather than another loop inside the watchtower.
 *
 * Two passes, because two different things produce an alert:
 *
 *   events   Faults, slashes, challenges and unbondings are all logs. Followed from a cursor,
 *            windowed, and deduplicated by transaction hash and log index — several daemons may
 *            run at once and the unique index makes that harmless.
 *   sweep    A score threshold is not an event. `decayHalfLife` pulls every score toward neutral
 *            continuously, so an agent can cross 5,000 with no transaction anywhere on chain and
 *            no log to follow. Watched agents are therefore re-read on a timer, and a crossing is
 *            the difference between two readings — not the current value, which would fire on
 *            every pass forever.
 *
 * Delivery is deliberately boring: queue a row, then send it. The queue is what makes a failed
 * webhook a retry rather than a lost alert, and what stops a slow endpoint holding up the scan.
 */

/** The events worth an alert, and which subscription kind each satisfies. */
const EVENT_KINDS = {
  FaultRecorded: "fault",
  Slashed: "fault",
  ExecutionChallenged: "challenge",
  UnbondingStarted: "unbonding",
};

/**
 * `pg`, required lazily.
 *
 * Every other mode here runs on ethers alone, and a key-holding process is not the place to
 * install a database driver nobody asked for. So it is an optional dependency, and the failure
 * mode when it is missing is a sentence telling you what to install rather than a stack trace.
 */
function requirePg() {
  try {
    return require("pg");
  } catch {
    throw new Error(
      "the alert daemon needs the `pg` package, which is optional here — install it with " +
        "`npm install pg` in relayer/. No other mode requires it."
    );
  }
}

async function openDb() {
  const url = config.alerts.databaseUrl;
  if (!url) {
    throw new Error(
      "no DATABASE_URL — the alert daemon reads subscriptions from the same database the " +
        "interface writes them to. Use the DIRECT Neon string here, not the pooled one; see " +
        "relayer/.env.example."
    );
  }
  const { Pool } = requirePg();
  const pool = new Pool({ connectionString: url, max: 2 });
  await pool.query("select 1");
  return pool;
}

/**
 * Re-check the webhook host at delivery time.
 *
 * The interface checked it when the row was stored, which is what makes an obvious attempt fail
 * visibly at the form. This is the check that matters operationally: a name resolves differently
 * an hour later, and the request that follows is made from inside this host's network. Neither
 * check closes DNS rebinding between this lookup and the socket — that needs dialling the resolved
 * address with the Host header carried through TLS — and it is recorded rather than papered over.
 */
async function hostIsPublic(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return "not a valid URL";
  }
  if (url.protocol !== "https:") return "not https";
  if (url.username || url.password) return "carries credentials";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses;
  try {
    addresses = net.isIP(host)
      ? [host]
      : (await dns.lookup(host, { all: true, verbatim: true })).map((a) => a.address);
  } catch {
    return `host does not resolve: ${host}`;
  }
  for (const address of addresses) {
    if (isPrivateAddress(address)) return `resolves to the private address ${address}`;
  }
  return null;
}

/** Live subscriptions for this deployment. Disabled rows are excluded by the partial index. */
async function liveSubscriptions(db, chainId, registry) {
  const { rows } = await db.query(
    `select id, agent_id, kind, threshold, webhook_url, delivery_secret
       from alert_subscription
      where chain_id = $1 and registry = $2 and disabled_at is null`,
    [chainId, registry.toLowerCase()]
  );
  return rows.map((r) => ({
    id: Number(r.id),
    agentId: BigInt(r.agent_id),
    kind: r.kind,
    threshold: r.threshold === null ? null : Number(r.threshold),
    webhookUrl: r.webhook_url,
    secret: r.delivery_secret,
  }));
}

/**
 * Queue one delivery.
 *
 * `on conflict do nothing` against the unique (subscription_id, event_key) is the whole of the
 * deduplication: a rescan after a restart, or a second daemon covering the same range, produces
 * the same key and the insert is a no-op. No locking, no leader election, no coordination.
 */
async function queue(db, subscriptionId, eventKey, payload) {
  const { rowCount } = await db.query(
    `insert into alert_delivery (subscription_id, event_key, payload)
     values ($1, $2, $3)
     on conflict do nothing`,
    [subscriptionId, eventKey, JSON.stringify(payload)]
  );
  return rowCount > 0;
}

async function readCursor(db, chainId, registry, fallback) {
  const { rows } = await db.query(
    `select block from alert_cursor where chain_id = $1 and registry = $2`,
    [chainId, registry.toLowerCase()]
  );
  return rows.length ? Number(rows[0].block) : fallback;
}

async function writeCursor(db, chainId, registry, block) {
  await db.query(
    `insert into alert_cursor (chain_id, registry, block) values ($1, $2, $3)
     on conflict (chain_id, registry) do update set block = excluded.block, updated_at = now()`,
    [chainId, registry.toLowerCase(), block]
  );
}

/**
 * Follow the logs from `cursor` to the head, in windows.
 *
 * Returns the next cursor. Every event is resolved to an agent id before it is matched against a
 * subscription — `ExecutionChallenged` carries only the request id, so the agent it concerns takes
 * a call to `getRequest`. That call is worth it: a challenge is the alert whose absence costs
 * money, because the escalation window is six hours and an agent that does not answer inside it is
 * slashed whether or not anyone told it.
 */
async function followEvents(db, chain, subs, cursor) {
  const { provider, contracts } = chain;
  const head = await provider.getBlockNumber();
  if (head < cursor) return cursor;

  const byAgent = new Map();
  for (const sub of subs) {
    const key = `${sub.agentId}:${sub.kind}`;
    if (!byAgent.has(key)) byAgent.set(key, []);
    byAgent.get(key).push(sub);
  }

  const sources = [
    [contracts.engine, "FaultRecorded"],
    [contracts.registry, "Slashed"],
    [contracts.registry, "UnbondingStarted"],
    [contracts.router, "ExecutionChallenged"],
  ];

  for (let from = cursor; from <= head; from += config.alerts.logWindow) {
    const to = Math.min(from + config.alerts.logWindow - 1, head);
    for (const [contract, name] of sources) {
      const events = await contract.queryFilter(contract.filters[name](), from, to);
      for (const ev of events) {
        let agentId;
        let detail;
        if (name === "ExecutionChallenged") {
          const request = await contracts.router.getRequest(ev.args.requestId);
          agentId = BigInt(request.agentId);
          detail = { requestId: ev.args.requestId, challenger: ev.args.challenger };
        } else {
          agentId = BigInt(ev.args.agentId);
          detail =
            name === "FaultRecorded"
              ? { faultKind: Number(ev.args.kind), score: Number(ev.args.newScore), faults: Number(ev.args.faults) }
              : name === "Slashed"
                ? { amount: ev.args.amount.toString(), recipient: ev.args.recipient }
                : { amount: ev.args.amount.toString(), availableAt: Number(ev.args.availableAt) };
        }

        const matches = byAgent.get(`${agentId}:${EVENT_KINDS[name]}`) ?? [];
        if (matches.length === 0) continue;
        // Transaction hash and log index, which is the one identifier for a log that survives a
        // rescan. A block number and a name would collide the moment two faults land together.
        const eventKey = `${ev.transactionHash}:${ev.index}`;
        for (const sub of matches) {
          const queued = await queue(db, sub.id, eventKey, {
            event: name,
            kind: sub.kind,
            agentId: agentId.toString(),
            chainId: Number(chain.chainId),
            blockNumber: ev.blockNumber,
            transactionHash: ev.transactionHash,
            ...detail,
          });
          if (queued) log.info(`alert queued: ${name} agent ${agentId} -> subscription ${sub.id}`);
        }
      }
    }
  }
  return head + 1;
}

/**
 * Re-read watched agents and fire on threshold crossings.
 *
 * A crossing, not a condition. `alert_agent_state` holds the previous reading, and an alert fires
 * only when the previous reading was on the other side of the line — otherwise "score below 5,000"
 * is true on every pass and the subscriber is notified forever.
 *
 * The first reading of an agent establishes the baseline and fires nothing. That is the correct
 * behaviour and it costs something worth naming: subscribe to "below 5,000" for an agent already
 * at 4,000 and nothing arrives until it climbs above and falls back. The alternative — firing once
 * on the first observation — would mean a daemon restart re-announces every standing condition.
 */
async function sweepScores(db, chain, subs) {
  const scoreSubs = subs.filter((s) => s.kind === "score_below" || s.kind === "score_above");
  if (scoreSubs.length === 0) return;

  const { provider, contracts, chainId } = chain;
  const registry = (await contracts.registry.getAddress()).toLowerCase();
  const block = await provider.getBlockNumber();
  const agents = [...new Set(scoreSubs.map((s) => s.agentId.toString()))];

  for (const id of agents) {
    let score;
    try {
      score = Number((await contracts.registry.getProfile(id)).score);
    } catch (e) {
      log.warn(`alert sweep: cannot read agent ${id}: ${e.shortMessage ?? e.message}`);
      continue;
    }

    const { rows } = await db.query(
      `select score from alert_agent_state where chain_id = $1 and registry = $2 and agent_id = $3`,
      [Number(chainId), registry, id]
    );
    const previous = rows.length && rows[0].score !== null ? Number(rows[0].score) : null;

    await db.query(
      `insert into alert_agent_state (chain_id, registry, agent_id, score, observed_at, observed_block)
       values ($1, $2, $3, $4, now(), $5)
       on conflict (chain_id, registry, agent_id)
       do update set score = excluded.score, observed_at = now(), observed_block = excluded.observed_block`,
      [Number(chainId), registry, id, score, block]
    );

    if (previous === null) continue; // baseline only

    for (const sub of scoreSubs.filter((s) => s.agentId.toString() === id)) {
      const crossed =
        sub.kind === "score_below"
          ? previous >= sub.threshold && score < sub.threshold
          : previous <= sub.threshold && score > sub.threshold;
      if (!crossed) continue;
      // Keyed on the block the crossing was noticed in, so two daemons sweeping at the same
      // height agree on the key and only one delivery survives the unique index.
      const eventKey = `cross:${sub.kind}:${sub.threshold}:${block}`;
      const queued = await queue(db, sub.id, eventKey, {
        event: "ScoreCrossed",
        kind: sub.kind,
        agentId: id,
        chainId: Number(chainId),
        threshold: sub.threshold,
        previousScore: previous,
        score,
        blockNumber: block,
      });
      if (queued) log.info(`alert queued: score ${previous} -> ${score} agent ${id} -> subscription ${sub.id}`);
    }
  }
}

/**
 * Send what is queued.
 *
 * The claim is the `attempts` increment: an update that only matches an undelivered row, returning
 * it. Two daemons racing the same row means one of them gets nothing back and moves on, which is
 * the same trick the watchtower uses to make its races harmless.
 */
async function deliverPending(db, chainId, registry) {
  const { rows } = await db.query(
    `select d.id, d.event_key, d.payload, d.attempts, s.id as sub_id, s.webhook_url, s.delivery_secret,
            s.failure_count
       from alert_delivery d
       join alert_subscription s on s.id = d.subscription_id
      where d.delivered_at is null
        and s.disabled_at is null
        and s.chain_id = $1 and s.registry = $2
      order by d.created_at
      limit 50`,
    [chainId, registry.toLowerCase()]
  );

  for (const row of rows) {
    const claim = await db.query(
      `update alert_delivery set attempts = attempts + 1
        where id = $1 and delivered_at is null returning id`,
      [row.id]
    );
    if (claim.rowCount === 0) continue;

    const body = JSON.stringify(row.payload);
    const bad = await hostIsPublic(row.webhook_url);
    if (bad) {
      await recordFailure(db, row, `webhook URL ${bad}`);
      continue;
    }

    try {
      const signature = crypto.createHmac("sha256", row.delivery_secret).update(body).digest("hex");
      const res = await fetch(row.webhook_url, {
        method: "POST",
        redirect: "error", // a redirect is how a public URL becomes a private one on the second hop
        signal: AbortSignal.timeout(config.alerts.deliverTimeoutMs),
        headers: {
          "content-type": "application/json",
          "x-botid-signature": signature,
          "x-botid-event": String(row.payload.event ?? ""),
          "user-agent": "botid-alerts/1",
        },
        body,
      });
      if (!res.ok) {
        await recordFailure(db, row, `endpoint returned ${res.status}`, res.status);
        continue;
      }
      await db.query(
        `update alert_delivery set delivered_at = now(), last_status = $2, last_error = null where id = $1`,
        [row.id, res.status]
      );
      await db.query(
        `update alert_subscription set failure_count = 0, last_error = null where id = $1`,
        [row.sub_id]
      );
      log.info(`alert delivered: subscription ${row.sub_id} ${row.event_key}`);
    } catch (e) {
      await recordFailure(db, row, e.message ?? String(e));
    }
  }
}

/**
 * Count a failure, and stop eventually.
 *
 * A subscription that has failed `maxFailures` times running is disabled rather than retried
 * forever — an endpoint that stopped answering months ago is a slow outbound scanner pointed at
 * somebody else's infrastructure, made worse by the fact that we sign every request. Resubscribing
 * clears it, which takes a signature, which is the right price for turning it back on.
 */
async function recordFailure(db, row, message, status = null) {
  const detail = message.slice(0, 500);
  await db.query(
    `update alert_delivery set last_error = $2, last_status = $3 where id = $1`,
    [row.id, detail, status]
  );
  const { rows } = await db.query(
    `update alert_subscription
        set failure_count = failure_count + 1,
            last_error = $2,
            disabled_at = case when failure_count + 1 >= $3 then now() else disabled_at end
      where id = $1
      returning failure_count, disabled_at`,
    [row.sub_id, detail, config.alerts.maxFailures]
  );
  const failures = Number(rows[0].failure_count);
  if (rows[0].disabled_at) {
    log.warn(`alert subscription ${row.sub_id} disabled after ${failures} failures: ${detail}`);
  } else {
    log.warn(`alert delivery failed (${failures}): subscription ${row.sub_id}: ${detail}`);
  }
}

async function run() {
  const db = await openDb();
  // No key. This mode signs nothing, and connect() is happy without one.
  const chain = await connect();
  const registry = await chain.contracts.registry.getAddress();
  const chainId = Number(chain.chainId);

  const head = await chain.provider.getBlockNumber();
  // A fallback of one log window back, not zero: a public RPC refuses an unbounded getLogs, and
  // at 0.75s blocks the whole of history is not reachable this way anyway. The cursor row is what
  // makes a restart resume rather than re-scan, and a gap longer than the window is a gap — the
  // daemon says so on startup rather than pretending it caught up.
  const fallback = config.alerts.fromBlock ?? Math.max(0, head - config.alerts.logWindow);
  let cursor = await readCursor(db, chainId, registry, fallback);
  if (head - cursor > config.alerts.logWindow * 20) {
    log.warn(
      `alert cursor is ${head - cursor} blocks behind — events in that gap will be scanned but ` +
        "the RPC may refuse ranges this old. Anything it refuses is missed, not retried."
    );
  }

  log.info(`alert daemon online on chain ${chainId}, following from block ${cursor}`);

  let lastSweep = 0;
  for (;;) {
    try {
      const subs = await liveSubscriptions(db, chainId, registry);
      if (subs.length > 0) {
        cursor = await followEvents(db, chain, subs, cursor);
        await writeCursor(db, chainId, registry, cursor);
        if (Date.now() - lastSweep >= config.alerts.sweepIntervalMs) {
          await sweepScores(db, chain, subs);
          lastSweep = Date.now();
        }
      } else {
        // Nothing watched. Keep the cursor at the head rather than accumulating a backlog nobody
        // subscribed to — a subscription made now is about what happens next, not what happened
        // while the table was empty.
        cursor = (await chain.provider.getBlockNumber()) + 1;
        await writeCursor(db, chainId, registry, cursor);
      }
      await deliverPending(db, chainId, registry);
    } catch (e) {
      log.error(`alert pass failed: ${e.shortMessage ?? e.message}`);
    }
    await sleep(config.pollIntervalMs);
  }
}

module.exports = { run, hostIsPublic, EVENT_KINDS };

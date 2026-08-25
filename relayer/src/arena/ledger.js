const fs = require("fs");
const path = require("path");
const config = require("../config");

/**
 * The Arena's memory.
 *
 * The two loops never speak to each other. The order loop writes a row and forgets it; hours
 * later the settle loop picks that row up and grades it. The file between them is the whole
 * interface — which is what makes either side restartable on its own, and what makes a crash
 * between ordering and settling survivable.
 *
 * `execute-once.js` reached the same conclusion for the same reason and put it better: a relay
 * baton, not a marathon. The state lives in the file, not in the process.
 *
 * What a row must carry is set by one rule: **the settle loop may not consult the market for
 * anything it should have known at order time.** Entry prices, the readings, the weights the
 * model was expected to produce — all captured before the answer could be known, so a
 * settlement can be re-derived by anyone holding the file and argued with. The only thing the
 * settle loop is allowed to go and find out is the exit price.
 */

function file() {
  return config.arena.ledgerFile;
}

function read() {
  const f = file();
  if (!fs.existsSync(f)) return { version: 1, rows: {} };
  const parsed = JSON.parse(fs.readFileSync(f, "utf8"));
  return { version: parsed.version ?? 1, rows: parsed.rows ?? {} };
}

/**
 * Write via a temporary file and a rename.
 *
 * A plain `writeFileSync` that is interrupted halfway leaves a truncated JSON file, and the
 * next start reads it, throws, and the Arena has forgotten every open request it is on the hook
 * to settle. Rename is atomic on both platforms this runs on, so the file on disk is always one
 * complete version or the other.
 */
function write(state) {
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, f);
}

/** Nothing here holds BigInt, on purpose — JSON cannot carry it and a silent 1e-15 is worse. */
const str = (v) => (v === undefined || v === null ? v : String(v));

function record(row) {
  const state = read();
  state.rows[row.requestId] = {
    ...row,
    notional: str(row.notional),
    fee: str(row.fee),
    entry: row.entry.map(str),
    readings: row.readings.map((r) => ({ ...r, value: str(r.value) })),
  };
  write(state);
  return state.rows[row.requestId];
}

function update(requestId, patch) {
  const state = read();
  const row = state.rows[requestId];
  if (!row) throw new Error(`no ledger row for ${requestId}`);
  state.rows[requestId] = { ...row, ...patch };
  write(state);
  return state.rows[requestId];
}

/** Rows the settle loop still owes an answer for. */
function open() {
  return Object.values(read().rows).filter((r) => !r.closedAt);
}

/**
 * Close a row.
 *
 * Rows are marked rather than deleted. The Arena is the only record of why an agent's score
 * moved the way it did — the chain keeps the number, not the reasoning — and an operator asking
 * "why was my agent marked down" deserves an answer better than a shrug. `prune` exists for
 * when the file grows past usefulness; nothing calls it on a schedule.
 */
function close(requestId, outcome, note) {
  return update(requestId, {
    closedAt: Math.floor(Date.now() / 1000),
    note,
    outcome: outcome && { ...outcome, realizedPnlBps: str(outcome.realizedPnlBps) },
  });
}

function prune(olderThanSec) {
  const state = read();
  const cutoff = Math.floor(Date.now() / 1000) - olderThanSec;
  for (const [id, row] of Object.entries(state.rows)) {
    if (row.closedAt && row.closedAt < cutoff) delete state.rows[id];
  }
  write(state);
}

/** Last time the Arena ordered from each agent — the cooldown filter's input. */
function lastOrderedAt() {
  const seen = new Map();
  for (const row of Object.values(read().rows)) {
    const at = Number(row.orderedAt ?? 0);
    if (at > (seen.get(String(row.agentId)) ?? 0)) seen.set(String(row.agentId), at);
  }
  return seen;
}

/** Agent ids with an Arena job still in flight. One at a time keeps failures attributable. */
function busyAgents() {
  return new Set(open().map((r) => String(r.agentId)));
}

/** Fees committed so far, open and closed, against `ARENA_FEE_BUDGET`. */
function feesSpent() {
  return Object.values(read().rows).reduce((a, r) => a + BigInt(r.fee ?? 0), 0n);
}

module.exports = {
  file, read, write, record, update, open, close, prune,
  lastOrderedAt, busyAgents, feesSpent,
};

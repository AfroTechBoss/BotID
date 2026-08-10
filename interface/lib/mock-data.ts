// Typed mock data standing in for the data layer. Swap these functions for the real typed
// data-access layer (§11 of the brief) — RPC for live tail/point reads, Ponder for history and
// aggregates — keeping the same signatures.
//
// Two properties this module has to hold, both of which it lost once already:
//
//  1. Determinism. Nothing here may read the wall clock at module scope. These values are
//     produced during server rendering and again during hydration; if they disagree by so much
//     as a millisecond React discards the server HTML and warns. Every timestamp is derived from
//     MOCK_NOW, a fixed epoch.
//  2. Base units. Capital amounts are bigint, never number — see lib/token.ts for why.

import { applyBps, toBaseUnits } from './token';

export { formatToken, formatTokenParts, BOND_TOKEN, toBaseUnits, ratio, pct } from './token';

/** Fixed reference instant: 2026-08-09T12:00:00Z. Fixtures are relative to this, not to now. */
export const MOCK_NOW = 1_754_740_800_000;

function mulberry32(seed: number) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// The module-scope stream. Safe for the fixtures built once at module load below, because those
// run in a fixed order exactly once per module instance. NOT safe inside anything called during
// render — see genExecutions and genScoreHistory, which take their own stream for that reason.
const rnd = mulberry32(42);
const pick = <T,>(arr: T[], r: () => number = rnd): T => arr[Math.floor(r() * arr.length)];
const hex = (n: number, r: () => number = rnd) =>
  Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(r() * 16)]).join('');
const addr = (r: () => number = rnd) => '0x' + hex(40, r);
const reqId = (r: () => number = rnd) => '0x' + hex(64, r);

export type Tier = 'bronze' | 'silver' | 'gold';
export const TIERS: Tier[] = ['bronze', 'silver', 'gold'];
export const TIER_META: Record<Tier, { label: string; rings: number; dot: boolean; color: string }> = {
  bronze: { label: 'Bronze', rings: 1, dot: false, color: 'var(--tier-bronze)' },
  silver: { label: 'Silver', rings: 2, dot: false, color: 'var(--tier-silver)' },
  gold: { label: 'Gold', rings: 2, dot: true, color: 'var(--tier-gold)' },
};

/** Credit multiplier by tier, in basis points. Mirrors tierFactor × leverage on chain. */
const LEVERAGE_BPS: Record<Tier, number> = { bronze: 25_000, silver: 42_000, gold: 60_000 };

export interface Agent {
  id: number; address: string; operator: string; tier: Tier; score: number;
  delta: number; settled: number; faults: number;
  bond: bigint; maxOpenNotional: bigint; openNotional: bigint;
  lastActiveAt: number; modelCommitment: string;
}

export function shortHash(h: string, n = 4) {
  if (!h) return '';
  return h.slice(0, n + 2) + '…' + h.slice(-n);
}

export function formatNum(n: number) { return n.toLocaleString('en-US'); }

export function timeAgo(ts: number, now = MOCK_NOW) {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

export function scoreBand(score: number) {
  if (score < 2500) return 'critical';
  if (score < 4500) return 'weak';
  if (score < 5500) return 'neutral';
  if (score < 8000) return 'good';
  return 'strong';
}
export function scoreColorVar(score: number) { return `var(--score-${scoreBand(score)})`; }

function makeAgent(id: number, opts: Partial<Omit<Agent, 'bond'>> & { bond?: number; stale?: boolean } = {}): Agent {
  const tier = opts.tier || pick(TIERS);
  const score = opts.score ?? Math.round(2000 + rnd() * 8000);
  const settled = opts.settled ?? Math.round(rnd() * 400);
  const faults = opts.faults ?? (rnd() < 0.12 ? Math.round(1 + rnd() * 3) : 0);
  const bond = toBaseUnits(opts.bond ?? Math.round(5000 + rnd() * 200000));
  const maxOpenNotional = applyBps(bond, LEVERAGE_BPS[tier]);
  const openNotional = applyBps(maxOpenNotional, Math.round(rnd() * 6000));
  const lastActiveAt = MOCK_NOW - Math.round(rnd() * (opts.stale ? 12 : 0.3) * 86400000);
  return {
    id, address: addr(), operator: addr(), tier, score,
    delta: Math.round((rnd() - 0.4) * 80), settled, faults,
    bond, maxOpenNotional, openNotional, lastActiveAt, modelCommitment: '0x' + hex(64),
  };
}

export const SPARSE_AGENTS: Agent[] = [
  makeAgent(7, { tier: 'gold', score: 8450, settled: 318, faults: 0 }),
  makeAgent(3, { tier: 'silver', score: 7910, settled: 44, faults: 0 }),
  makeAgent(11, { tier: 'bronze', score: 5002, settled: 2, faults: 1 }),
];
// The three featured agents first, then the generated ones that do not collide with them. This
// used to overwrite slots 0 and 1, which dropped ids 1 and 2 and left ids 3 and 7 in the list
// twice — two different objects claiming the same agent. Nothing caught it while every generated
// value came off a shared stream, because the duplicates still differed; the moment fixtures are
// keyed by agent id, two agents with one id produce byte-identical rows and collide as React keys.
// Still 42 agents, and #11 is now the same agent the overview features rather than a lookalike.
export const DENSE_AGENTS: Agent[] = [
  ...SPARSE_AGENTS,
  ...Array.from({ length: 42 }, (_, i) => makeAgent(i + 1)).filter(
    (a) => !SPARSE_AGENTS.some((s) => s.id === a.id)
  ),
];

export type Verb = 'REQUEST' | 'DELIVER' | 'CHALLENGE' | 'RESOLVE' | 'SETTLE' | 'EXPIRE' | 'SLASH';

export interface FeedRow {
  id: string; time: number; verb: Verb; requestId: string; agentId: number; tier: Tier;
  detail: string; delta?: number; scoreFrom?: number; scoreTo?: number; bps?: number;
}

import { formatToken as fmt } from './token';

export function genFeedRow(agents: Agent[], now = MOCK_NOW): FeedRow {
  const agent = pick(agents);
  const verb = pick<Verb>(['REQUEST', 'DELIVER', 'DELIVER', 'SETTLE', 'SETTLE', 'CHALLENGE', 'EXPIRE', 'SLASH']);
  const notional = toBaseUnits(Math.round(5000 + rnd() * 300000));
  const requestId = reqId();
  const row: FeedRow = { id: reqId() + now + rnd(), time: now, verb, requestId, agentId: agent.id, tier: agent.tier, detail: '' };
  if (verb === 'REQUEST') row.detail = `${fmt(notional)} · deliver by ${clock(now + 3600e3)}`;
  if (verb === 'DELIVER') row.detail = `${TIER_META[agent.tier].label.toUpperCase()} · ${fmt(notional)} · 6h window · 412k gas`;
  if (verb === 'SETTLE') {
    const delta = Math.round((rnd() - 0.35) * 90);
    row.delta = delta; row.scoreFrom = agent.score; row.scoreTo = Math.max(0, Math.min(10000, agent.score + delta));
    row.bps = Math.round((rnd() - 0.3) * 60);
    row.detail = `${row.bps >= 0 ? '+' : ''}${row.bps} bps · in-spec · ${formatNum(row.scoreFrom)} → ${formatNum(row.scoreTo)}`;
  }
  if (verb === 'CHALLENGE') row.detail = `bond ${fmt(toBaseUnits(5000))} · answer by ${clock(now + 7200e3)}`;
  if (verb === 'EXPIRE') row.detail = `LIVENESS FAULT · −${Math.round(600 + rnd() * 1200)}`;
  if (verb === 'SLASH') row.detail = `CHALLENGE LOST · SLASHED ${fmt(applyBps(notional, 1000))}`;
  return row;
}

/** UTC so a server render and a client render agree regardless of the reader's timezone. */
function clock(ts: number) {
  const d = new Date(ts);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

export const EXECUTIONS_PER_DAY = Array.from({ length: 14 }, () => ({
  bronze: Math.round(rnd() * 12), silver: Math.round(rnd() * 8), gold: Math.round(rnd() * 5),
}));

export interface ScorePoint { day: number; score: number; notional: bigint; fault: boolean }

export function genScoreHistory(agent: Agent, days = 90): ScorePoint[] {
  // Own stream, seeded from the agent — same reasoning as genExecutions. An agent's history is a
  // fact about that agent, so it must not change because something else drew a number first.
  const r = mulberry32(seedFrom(`score:${agent.id}`));
  const target = agent.score;
  let s = target - 400 + (r() - 0.5) * 300;
  const points: ScorePoint[] = [];
  for (let i = days; i >= 0; i--) {
    const notionalWhole = r() < 0.82 ? 0 : Math.round(5000 + r() * 180000);
    const fault = notionalWhole > 0 && r() < 0.04;
    if (notionalWhole > 0) {
      // The EWMA itself stays in float: it is a simulation of the on-chain update, not a
      // capital amount, and nothing settles against it.
      const q = fault ? r() * 1500 : target - 600 + r() * 1200;
      const w = Math.min(notionalWhole, 200000);
      s = s * 0.998 + (q - s * 0.998) * (w / (w + 90000));
    } else {
      s = s + (target - s) * 0.006;
    }
    s = Math.max(0, Math.min(10000, s));
    points.push({ day: days - i, score: Math.round(s), notional: toBaseUnits(notionalWhole), fault });
  }
  points[points.length - 1].score = target;
  return points;
}

export interface Execution { requestId: string; status: string; notional: bigint; bps: number; time: number }
export function genExecutions(agent: Agent, n = 24, now = MOCK_NOW): Execution[] {
  // Its own stream, seeded from the agent, for the reason spelled out under ExecutionDetail
  // below: this is called during render, so drawing from the module-scope `rnd` made the result
  // depend on how many draws had already happened. On the server the module outlives the request,
  // so the second visit to a route started from a different position than the first; in the
  // browser it started from wherever module init left it. The two disagreed and React threw the
  // server HTML away. It also meant re-rendering — changing the filter — silently re-rolled every
  // row, so the same execution never kept the same id twice.
  const r = mulberry32(seedFrom(`executions:${agent.id}`));
  const statuses = ['Settled', 'Settled', 'Settled', 'Finalized', 'Challenged', 'Faulted', 'Expired', 'Pending'];
  return Array.from({ length: n }, (_, i) => ({
    requestId: reqId(r), status: pick(statuses, r),
    notional: toBaseUnits(Math.round(5000 + r() * 300000)),
    bps: Math.round((r() - 0.3) * 60), time: now - i * (3 + r() * 20) * 3600000,
  }));
}

/**
 * A single execution, derived from its requestId alone.
 *
 * Deliberately does NOT use `rnd`: that generator is module-scope and its sequence depends on how
 * many times it has already been called, so a value drawn from it would differ between a server
 * render and a client render of the same route. A detail page must be a pure function of its URL —
 * that is the entire reason these pages are server components, and the reason a pasted link shows
 * the same receipt to the sender and the recipient.
 */
export interface ExecutionDetail {
  requestId: string; agent: Agent; tier: Tier; notional: bigint; feeBps: number;
  deliveredAt: number; blocks: { request: number; deliver: number; finalize: number; settle: number };
  scoreDelta: number; realizedBps: number;
}

function seedFrom(requestId: string): number {
  let h = 2166136261;
  for (let i = 0; i < requestId.length; i++) { h ^= requestId.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function getExecution(requestId: string): ExecutionDetail {
  const r = mulberry32(seedFrom(requestId));
  const agent = SPARSE_AGENTS[Math.floor(r() * SPARSE_AGENTS.length)];
  const settleBlock = 8_412_900 + Math.floor(r() * 400);
  return {
    requestId,
    agent,
    tier: agent.tier,
    notional: toBaseUnits(Math.round(5000 + r() * 300000)),
    feeBps: Math.round(20 + r() * 80),
    deliveredAt: MOCK_NOW - Math.round(1 + r() * 8) * 3600000,
    blocks: {
      request: settleBlock - 1878, deliver: settleBlock - 1660,
      finalize: settleBlock - 20, settle: settleBlock,
    },
    scoreDelta: Math.round((r() - 0.3) * 90),
    realizedBps: Math.round((r() - 0.3) * 60),
  };
}

export function genFeedCells() {
  return {
    inputs: [
      { label: 'BOT/USD', raw: 12500, feedId: '0x8f2a…' },
      { label: 'ETH/USD', raw: 34000, feedId: '0x1c4b…' },
      { label: 'BTC/USD', raw: 4200, feedId: '0x77de…' },
    ],
    outputs: [{ label: 'hold', bps: 0 }, { label: 'allocate', bps: 10000 }, { label: 'hedge', bps: 0 }],
  };
}

export const SAMPLE_REQUEST_ID = '0x1c8e' + hex(56) + '04f1';
export const SAMPLE_AGENT = SPARSE_AGENTS[0];

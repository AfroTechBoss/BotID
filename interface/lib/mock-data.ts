// Straight TypeScript port of the HTML prototypes' generator (lib/mock-data.js at the project root).
// Swap these functions for the real typed data-access layer (§11 of the brief) — RPC for live
// tail/point reads, Ponder for history/aggregates — keeping the same signatures.

function mulberry32(seed: number) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(42);
const pick = <T,>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)];
const hex = (n: number) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(rnd() * 16)]).join('');
const addr = () => '0x' + hex(40);
const reqId = () => '0x' + hex(64);

export type Tier = 'bronze' | 'silver' | 'gold';
export const TIERS: Tier[] = ['bronze', 'silver', 'gold'];
export const TIER_META: Record<Tier, { label: string; rings: number; dot: boolean; color: string }> = {
  bronze: { label: 'Bronze', rings: 1, dot: false, color: 'var(--tier-bronze)' },
  silver: { label: 'Silver', rings: 2, dot: false, color: 'var(--tier-silver)' },
  gold: { label: 'Gold', rings: 2, dot: true, color: 'var(--tier-gold)' },
};

export interface Agent {
  id: number; address: string; operator: string; tier: Tier; score: number;
  delta: number; settled: number; faults: number; bond: number; maxOpenNotional: number;
  openNotional: number; lastActiveAt: number; modelCommitment: string;
}

export function shortHash(h: string, n = 4) {
  if (!h) return '';
  return h.slice(0, n + 2) + '\u2026' + h.slice(-n);
}

// Bond and notional are denominated in WBOT (the recommended bond token, §20.4) so credit and exposure move together.
export function formatToken(n: number) {
  if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1) + 'M WBOT';
  if (n >= 1e3) return (n / 1e3).toFixed(n % 1e3 === 0 ? 0 : 1) + 'k WBOT';
  return Math.round(n) + ' WBOT';
}
export function formatNum(n: number) { return n.toLocaleString('en-US'); }

export function timeAgo(ts: number, now = Date.now()) {
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

function makeAgent(id: number, opts: Partial<Agent> & { stale?: boolean } = {}): Agent {
  const tier = opts.tier || pick(TIERS);
  const score = opts.score ?? Math.round(2000 + rnd() * 8000);
  const settled = opts.settled ?? Math.round(rnd() * 400);
  const faults = opts.faults ?? (rnd() < 0.12 ? Math.round(1 + rnd() * 3) : 0);
  const bond = opts.bond ?? Math.round(5000 + rnd() * 200000);
  const leverage = tier === 'gold' ? 6 : tier === 'silver' ? 4.2 : 2.5;
  const maxOpenNotional = Math.round(bond * leverage);
  const openNotional = Math.round(maxOpenNotional * rnd() * 0.6);
  const lastActiveAt = Date.now() - Math.round(rnd() * (opts.stale ? 12 : 0.3) * 86400000);
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
export const DENSE_AGENTS: Agent[] = Array.from({ length: 42 }, (_, i) => makeAgent(i + 1));
DENSE_AGENTS[0] = SPARSE_AGENTS[0];
DENSE_AGENTS[1] = SPARSE_AGENTS[1];

export type Verb = 'REQUEST' | 'DELIVER' | 'CHALLENGE' | 'RESOLVE' | 'SETTLE' | 'EXPIRE' | 'SLASH';

export interface FeedRow {
  id: string; time: number; verb: Verb; requestId: string; agentId: number; tier: Tier;
  detail: string; delta?: number; scoreFrom?: number; scoreTo?: number; bps?: number;
}

export function genFeedRow(agents: Agent[], now = Date.now()): FeedRow {
  const agent = pick(agents);
  const verb = pick<Verb>(['REQUEST', 'DELIVER', 'DELIVER', 'SETTLE', 'SETTLE', 'CHALLENGE', 'EXPIRE', 'SLASH']);
  const notional = Math.round(5000 + rnd() * 300000);
  const requestId = reqId();
  const row: FeedRow = { id: reqId() + now + rnd(), time: now, verb, requestId, agentId: agent.id, tier: agent.tier, detail: '' };
  if (verb === 'REQUEST') row.detail = `${formatToken(notional)} \u00b7 deliver by ${new Date(now + 3600e3).toLocaleTimeString('en-US', { hour12: false }).slice(0, 5)}`;
  if (verb === 'DELIVER') row.detail = `${TIER_META[agent.tier].label.toUpperCase()} \u00b7 ${formatToken(notional)} \u00b7 6h window \u00b7 412k gas`;
  if (verb === 'SETTLE') {
    const delta = Math.round((rnd() - 0.35) * 90);
    row.delta = delta; row.scoreFrom = agent.score; row.scoreTo = Math.max(0, Math.min(10000, agent.score + delta));
    row.bps = Math.round((rnd() - 0.3) * 60);
    row.detail = `${row.bps >= 0 ? '+' : ''}${row.bps} bps \u00b7 in-spec \u00b7 ${formatNum(row.scoreFrom)} \u2192 ${formatNum(row.scoreTo)}`;
  }
  if (verb === 'CHALLENGE') row.detail = `bond ${formatToken(5000)} \u00b7 answer by ${new Date(now + 7200e3).toLocaleTimeString('en-US', { hour12: false }).slice(0, 5)}`;
  if (verb === 'EXPIRE') row.detail = `LIVENESS FAULT \u00b7 \u2212${Math.round(600 + rnd() * 1200)}`;
  if (verb === 'SLASH') row.detail = `CHALLENGE LOST \u00b7 SLASHED ${formatToken(notional * 0.1)}`;
  return row;
}

export const EXECUTIONS_PER_DAY = Array.from({ length: 14 }, () => ({
  bronze: Math.round(rnd() * 12), silver: Math.round(rnd() * 8), gold: Math.round(rnd() * 5),
}));

export interface ScorePoint { day: number; score: number; notional: number; fault: boolean }

export function genScoreHistory(agent: Agent, days = 90): ScorePoint[] {
  const target = agent.score;
  let s = target - 400 + (rnd() - 0.5) * 300;
  const points: ScorePoint[] = [];
  for (let i = days; i >= 0; i--) {
    const notional = rnd() < 0.82 ? 0 : Math.round(5000 + rnd() * 180000);
    const fault = notional > 0 && rnd() < 0.04;
    if (notional > 0) {
      const q = fault ? rnd() * 1500 : target - 600 + rnd() * 1200;
      const w = Math.min(notional, 200000);
      s = s * 0.998 + (q - s * 0.998) * (w / (w + 90000));
    } else {
      s = s + (target - s) * 0.006;
    }
    s = Math.max(0, Math.min(10000, s));
    points.push({ day: days - i, score: Math.round(s), notional, fault });
  }
  points[points.length - 1].score = target;
  return points;
}

export interface Execution { requestId: string; status: string; notional: number; bps: number; time: number }
export function genExecutions(agent: Agent, n = 24): Execution[] {
  const statuses = ['Settled', 'Settled', 'Settled', 'Finalized', 'Challenged', 'Faulted', 'Expired', 'Pending'];
  return Array.from({ length: n }, (_, i) => ({
    requestId: reqId(), status: pick(statuses), notional: Math.round(5000 + rnd() * 300000),
    bps: Math.round((rnd() - 0.3) * 60), time: Date.now() - i * (3 + rnd() * 20) * 3600000,
  }));
}

export function genFeedCells() {
  return {
    inputs: [
      { label: 'BOT/USD', raw: 12500, feedId: '0x8f2a\u2026' },
      { label: 'ETH/USD', raw: 34000, feedId: '0x1c4b\u2026' },
      { label: 'BTC/USD', raw: 4200, feedId: '0x77de\u2026' },
    ],
    outputs: [{ label: 'hold', bps: 0 }, { label: 'allocate', bps: 10000 }, { label: 'hedge', bps: 0 }],
  };
}

export const SAMPLE_REQUEST_ID = '0x1c8e' + hex(56) + '04f1';
export const SAMPLE_AGENT = SPARSE_AGENTS[0];

// Display helpers: tier metadata, score bands, hashes, counts, relative times.
//
// Split out of mock-data.ts, and the split is the point rather than tidiness. These functions were
// living beside the fixture generator, so a page that reads the chain and wants nothing but
// `timeAgo` had to import the module that builds forty-two invented agents — dragging the
// generator, its seeded PRNG and its whole fixture set into a bundle that renders none of it, and
// making "does this page use mock data?" unanswerable by reading its imports.
//
// Nothing here invents a value. Every function takes something real and formats it. mock-data.ts
// re-exports the lot, so the fixture-backed pages did not have to change.

import type { TierName } from './registry';

/** The tier vocabulary the interface renders. Same three names as the contract's enum. */
export type Tier = TierName;
export const TIERS: Tier[] = ['bronze', 'silver', 'gold'];

export const TIER_META: Record<Tier, { label: string; rings: number; dot: boolean; color: string }> = {
  bronze: { label: 'Bronze', rings: 1, dot: false, color: 'var(--tier-bronze)' },
  silver: { label: 'Silver', rings: 2, dot: false, color: 'var(--tier-silver)' },
  gold: { label: 'Gold', rings: 2, dot: true, color: 'var(--tier-gold)' },
};

export function shortHash(h: string, n = 4) {
  if (!h) return '';
  return h.slice(0, n + 2) + '…' + h.slice(-n);
}

export function formatNum(n: number) { return n.toLocaleString('en-US'); }

/**
 * `now` has no default any more.
 *
 * It used to fall back to MOCK_NOW, which is a build-time constant — so a chain-backed page that
 * forgot the argument would have dated a real event against the moment the bundle was compiled and
 * reported it, quite confidently, as several hours old. Making the caller name its clock means a
 * page rendering real timestamps has to have a real one.
 */
export function timeAgo(ts: number, now: number) {
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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** UTC, so a reading does not shift with the reader's timezone. */
export function dayLabel(ms: number) {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

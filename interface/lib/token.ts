// Capital amounts are base units, and base units are bigint.
//
// Every figure the protocol holds — bond, notional, credit, challenge bond — is a uint256 scaled
// by the bond token's decimals(). Reading one into a JS number loses precision above 2^53 and,
// worse, invites code that "just" divides by 1e18 and is silently wrong the day the bond token
// has six decimals. That is the same failure deploy.js exists to prevent on the contract side;
// this module is the same guard on the display side.
//
// The rule: bigint from the chain to the formatter, and the formatter is the only place decimals
// are applied.

/**
 * The bond token is NOT decided yet — this is Q3 in the brief, and it is still open.
 *
 * WBOT is the current recommendation because it is fully collateralised by native BOT with no
 * privileged issuance. BOT Chain's "USDT" was ruled out: it is not Tether but a mintable token
 * with a MINTER_ROLE, and permissioned issuance underneath slashable collateral would make the
 * protocol's Sybil bound a permission rather than a cost.
 *
 * Nothing outside this object may hardcode a symbol or a decimals value. When Q3 is answered,
 * this is the only place that changes — and on a real deployment it should be read from the
 * token's own decimals() rather than trusted from here.
 */
export const BOND_TOKEN = {
  symbol: 'WBOT',
  decimals: 18,
} as const;

/** Whole tokens to base units. For fixtures and for parsing user input, never for chain reads. */
export function toBaseUnits(whole: number, decimals: number = BOND_TOKEN.decimals): bigint {
  const [int, frac = ''] = whole.toString().split('.');
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(int) * 10n ** BigInt(decimals) + BigInt(padded || '0');
}

/** Scales a base-unit amount by a basis-point factor. Keeps leverage maths in integer space. */
export function applyBps(amount: bigint, bps: number): bigint {
  return (amount * BigInt(Math.round(bps))) / 10_000n;
}

/**
 * Formats base units for display: compact above a thousand, and never more precision than the
 * reader can act on. Returns digits and symbol separately so callers can style them apart —
 * a table column that right-aligns the number and greys the symbol is the common case.
 */
export function formatToken(
  amount: bigint,
  { decimals = BOND_TOKEN.decimals, symbol = BOND_TOKEN.symbol as string, compact = true } = {}
): string {
  const { value, suffix } = scale(amount, decimals, compact);
  return `${value}${suffix} ${symbol}`;
}

export function formatTokenParts(
  amount: bigint,
  { decimals = BOND_TOKEN.decimals, symbol = BOND_TOKEN.symbol as string, compact = true } = {}
): { value: string; symbol: string } {
  const { value, suffix } = scale(amount, decimals, compact);
  return { value: `${value}${suffix}`, symbol };
}

/**
 * The one sanctioned way out of bigint and into number.
 *
 * A ratio of two capital amounts is dimensionless and small, so it is safe in a float — but only
 * if the division happens in integer space first. `Number(a) / Number(b)` converts two 1e18-scale
 * values through float before dividing, which is exactly the pattern this module exists to stop.
 * Returns 0 for a zero denominator: an agent with no bond has used none of its credit, and a NaN
 * would render as "NaN%" in a table cell.
 */
export function ratio(part: bigint, whole: bigint, precision = 1_000_000): number {
  if (whole === 0n) return 0;
  return Number((part * BigInt(precision)) / whole) / precision;
}

/** A percentage of one amount against another, rounded — for progress bars and table cells. */
export function pct(part: bigint, whole: bigint): number {
  return Math.round(ratio(part, whole) * 100);
}

function scale(amount: bigint, decimals: number, compact: boolean) {
  const unit = 10n ** BigInt(decimals);
  const whole = amount / unit;

  if (compact) {
    if (whole >= 1_000_000n) return { value: trim(whole, 1_000_000n), suffix: 'M' };
    if (whole >= 1_000n) return { value: trim(whole, 1_000n), suffix: 'k' };
  }
  return { value: whole.toLocaleString('en-US'), suffix: '' };
}

/** One decimal place, dropped when it is a zero — 1.5M, but 2M rather than 2.0M. */
function trim(whole: bigint, div: bigint): string {
  const units = whole / div;
  const tenths = ((whole % div) * 10n) / div;
  return tenths === 0n ? units.toLocaleString('en-US') : `${units.toLocaleString('en-US')}.${tenths}`;
}

import { Tier, TIER_META } from '@/lib/format';

// One mark, two independent channels: ring construction = tier (single / double / double+dot),
// ring colour = fault status. Never let tier hue double as a "good/bad" signal (§2.2).
//
// The construction has to carry the tier on its own, because colour cannot: a reader with
// deuteranopia, a greyscale print, or a screenshot run through a compressor all lose hue and
// keep geometry. It is also why the badge announces itself in words rather than relying on a
// viewer knowing what two rings mean.
export default function BotIdBadge({
  tier,
  hasFault,
  size = 22,
}: {
  tier: Tier;
  hasFault: boolean;
  size?: number;
}) {
  const tm = TIER_META[tier];
  const status = hasFault ? 'var(--score-critical)' : 'var(--score-good)';

  // Ring weight scales with the mark so it stays legible at 16px in a table row and at 64px on
  // a profile. Below ~1.5px the inner ring stops resolving on a 1x display.
  const w = Math.max(1.5, Math.round(size * 0.09));
  const rings =
    tm.rings === 2
      ? `inset 0 0 0 ${w}px ${status}, inset 0 0 0 ${w * 2}px var(--color-bg), inset 0 0 0 ${w * 3}px ${status}`
      : `inset 0 0 0 ${w}px ${status}`;

  const label = `${tm.label} tier, ${hasFault ? 'has faults' : 'no faults'}`;

  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      style={{ position: 'relative', display: 'inline-block', width: size, height: size, flex: 'none' }}
    >
      <span style={{ display: 'block', width: '100%', height: '100%', borderRadius: '50%', boxShadow: rings }} />
      {tm.dot && (
        <span
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            width: size * 0.2,
            height: size * 0.2,
            marginTop: -size * 0.1,
            marginLeft: -size * 0.1,
            borderRadius: '50%',
            background: tm.color,
          }}
        />
      )}
    </span>
  );
}

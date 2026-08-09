import { Tier, TIER_META } from '@/lib/mock-data';

// One mark, two independent channels: ring construction = tier (single/double/double+dot),
// ring color = fault status (green/red). Never let tier hue double as a "good/bad" signal (§2.2).
export default function BotIdBadge({ tier, hasFault, size = 22 }: { tier: Tier; hasFault: boolean; size?: number }) {
  const tm = TIER_META[tier];
  const statusColor = hasFault ? 'var(--score-critical)' : 'var(--score-good)';
  const ring = tm.rings === 2
    ? `inset 0 0 0 2px var(--color-bg), inset 0 0 0 3px ${statusColor}`
    : `inset 0 0 0 2px var(--color-bg), inset 0 0 0 3px ${statusColor}`;
  return (
    <span style={{ position: 'relative', display: 'inline-block', width: size, height: size, flex: 'none' }}>
      <span style={{ display: 'block', width: '100%', height: '100%', borderRadius: '50%', boxShadow: ring }} />
      {tm.dot && (
        <span style={{ position: 'absolute', top: '50%', left: '50%', width: size * 0.18, height: size * 0.18, marginTop: -size * 0.09, marginLeft: -size * 0.09, borderRadius: '50%', background: tm.color }} />
      )}
    </span>
  );
}

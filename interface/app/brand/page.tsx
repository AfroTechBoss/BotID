import type { Metadata } from 'next';
import BotIdBadge from '@/components/BotIdBadge';
import { TIER_META, Tier } from '@/lib/mock-data';

export const metadata: Metadata = {
  title: 'Brand',
  description: 'The BotID mark, palette and type — the tokens the interface actually renders.',
};

const TIERS: Tier[] = ['bronze', 'silver', 'gold'];

// Measured, not asserted: each ratio is the token converted from oklch to sRGB and compared
// against --color-bg (#171615) by the WCAG formula. Quoting a contrast figure you have not
// computed is how a palette ends up with a comment promising something the colours do not do.
const PALETTE: { role: string; token: string; value: string; ratio: string }[] = [
  { role: 'Ground', token: '--color-bg', value: '#171615', ratio: '—' },
  { role: 'Ink', token: '--color-text', value: '#f3f2f2', ratio: '16.2:1' },
  { role: 'Accent', token: '--color-accent', value: '#ff563c', ratio: '5.7:1' },
  { role: 'Tier — Bronze', token: '--tier-bronze', value: 'oklch(66% .09 55)', ratio: '5.7:1' },
  { role: 'Tier — Silver', token: '--tier-silver', value: 'oklch(78% .02 250)', ratio: '9.1:1' },
  { role: 'Tier — Gold', token: '--tier-gold', value: 'oklch(82% .12 85)', ratio: '10.3:1' },
  { role: 'Score — critical', token: '--score-critical', value: 'oklch(62% .20 25)', ratio: '4.5:1' },
  { role: 'Score — good', token: '--score-good', value: 'oklch(74% .14 152)', ratio: '8.3:1' },
  { role: 'Score — strong', token: '--score-strong', value: 'oklch(84% .16 152)', ratio: '11.7:1' },
  { role: 'Liveness', token: '--live', value: 'oklch(72% .13 240)', ratio: '7.4:1' },
];

const HEAD: React.CSSProperties = {
  margin: 'var(--space-6) 0 var(--space-3)',
  color: 'var(--text-muted)',
};
const RULE: React.CSSProperties = {
  borderTop: '2px solid var(--color-divider)',
  borderBottom: '2px solid var(--color-divider)',
  padding: 'var(--space-4) 0',
};

export default function Brand() {
  return (
    // Uncapped so the specimen rows get the room they are for. The intro keeps a measure of its
    // own, because that part is reading and the swatches are not — the split globals.css
    // describes, applied within one page rather than between pages.
    <main style={{ padding: 'var(--space-8) var(--space-6)' }}>
      <h1 style={{ fontSize: 28 }}>Brand</h1>
      <p className="text-muted measure">
        The BotIdBadge is the mark: ring construction is the tier, ring colour is fault status, and
        the two are independent. Everything below is rendered by the same components and tokens the
        rest of the interface uses, so this page cannot drift from what ships.
      </p>

      <h6 style={HEAD}>Badge construction</h6>
      {/* These are real <BotIdBadge> elements, not lookalikes. The page used to draw its own
          circles with hand-written box-shadows, and they had gone wrong in the way copies always
          do: they coloured the rings by tier, which is precisely what the component does not do
          and what the palette rule exists to prevent. The sample said Gold was a gold ring; the
          product draws a gold dot inside a green ring. A brand page that contradicts the mark is
          worse than no brand page. */}
      <div style={{ ...RULE, display: 'flex', flexWrap: 'wrap', gap: 'var(--space-6) var(--space-8)', alignItems: 'flex-start' }}>
        {TIERS.map((tier) => (
          <figure key={tier} style={{ margin: 0, textAlign: 'center', width: 120 }}>
            <BotIdBadge tier={tier} hasFault={false} size={56} />
            <figcaption style={{ fontSize: 11, marginTop: 8 }}>
              <strong>{TIER_META[tier].label}</strong>
              <div className="text-muted" style={{ marginTop: 2 }}>
                {TIER_META[tier].rings === 2 ? 'double ring' : 'single ring'}
                {TIER_META[tier].dot ? ' + dot' : ''}
              </div>
            </figcaption>
          </figure>
        ))}
      </div>

      <h6 style={HEAD}>The second channel: fault status</h6>
      <div style={{ ...RULE, display: 'flex', flexWrap: 'wrap', gap: 'var(--space-6) var(--space-8)', alignItems: 'flex-start' }}>
        {[false, true].map((hasFault) => (
          <figure key={String(hasFault)} style={{ margin: 0, textAlign: 'center', width: 120 }}>
            <BotIdBadge tier="gold" hasFault={hasFault} size={56} />
            <figcaption style={{ fontSize: 11, marginTop: 8 }}>
              <strong>{hasFault ? 'Faulted' : 'Clean'}</strong>
              <div className="text-muted" style={{ marginTop: 2 }}>
                ring in {hasFault ? '--score-critical' : '--score-good'}
              </div>
            </figcaption>
          </figure>
        ))}
        <p className="text-muted" style={{ fontSize: 12, margin: 0, maxWidth: '40ch' }}>
          Both marks above are Gold. Tier is carried entirely by the geometry, so it survives
          greyscale, deuteranopia and a screenshot run through a compressor — none of which
          preserve hue. That is the whole reason the construction is not decorative.
        </p>
      </div>

      <h6 style={HEAD}>Type</h6>
      <div style={RULE}>
        <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 34, letterSpacing: '-0.02em' }}>
          Cabinet Grotesk Extrabold
        </div>
        <p className="text-muted" style={{ fontSize: 12, margin: '4px 0 var(--space-4)' }}>
          --font-heading · h1–h3 and the headline numerals, and nothing else. It is loud because it
          is rare; setting h4–h6 in it too would spend the emphasis on section labels.
        </p>
        <div style={{ fontFamily: 'var(--font-body)', fontWeight: 500, fontSize: 20 }}>
          Satoshi Medium — body copy, subheadings, tables and controls.
        </div>
        <p className="text-muted" style={{ fontSize: 12, margin: '4px 0 0' }}>
          --font-body · 500 for reading, 700 for h4–h6 and button labels. Both faces are
          self-hosted and preloaded; the interface makes no third-party font request.
        </p>
      </div>

      <h6 style={HEAD}>Palette</h6>
      <p className="text-muted" style={{ fontSize: 12, marginTop: 0 }}>
        Four hue families that never borrow from each other: accent is the interface talking, score
        is a diverging ramp around 5000, tier is metal, liveness is one reserved signal. Ratios are
        measured against --color-bg in the dark theme, which is the default.
      </p>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr><th>Role</th><th>Token</th><th>Value</th><th>Swatch</th><th>Contrast on ground</th></tr>
          </thead>
          <tbody>
            {PALETTE.map((p) => (
              <tr key={p.token}>
                <td>{p.role}</td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{p.token}</td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{p.value}</td>
                <td>
                  <span
                    aria-hidden="true"
                    style={{ display: 'inline-block', width: 40, height: 16, background: `var(${p.token})`, border: '1px solid var(--color-divider)' }}
                  />
                </td>
                <td className="tabular">{p.ratio}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h6 style={HEAD}>Do / Don&apos;t</h6>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(200px, 100%), 1fr))', gap: 'var(--space-4)', fontSize: 13 }}>
        <div>
          <strong>Do</strong>
          <ul>
            <li>Use the badge everywhere an agent is referenced.</li>
            <li>Let construction carry the tier, so it survives greyscale.</li>
            <li>Take colour from a token; never write a hex in a component.</li>
            <li>Flush-left every label.</li>
          </ul>
        </div>
        <div>
          <strong>Don&apos;t</strong>
          <ul>
            <li>Recolour the badge rings to match the tier.</li>
            <li>Reuse a token across two hue families — that is how Gold once rendered identically to a failing score.</li>
            <li>Round a corner on cards or buttons.</li>
            <li>Centre button labels.</li>
          </ul>
        </div>
      </div>
    </main>
  );
}

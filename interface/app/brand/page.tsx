
export default function Brand() {
  return (
    <>
      <main style={{ padding: 'var(--space-8) var(--space-6)', maxWidth: 900 }}>
        <h1 style={{ fontSize: 28 }}>Brand</h1>
        <p className="text-muted">The BotIdBadge is the mark: score arc, tier construction, fault overlay &mdash; one object that is the data.</p>

        <h6 style={{ margin: 'var(--space-6) 0 var(--space-3)', color: 'color-mix(in srgb, var(--color-text) 60%, transparent)' }}>Badge construction</h6>
        <div style={{ display: 'flex', gap: 'var(--space-6)', alignItems: 'center', borderTop: '2px solid var(--color-divider)', borderBottom: '2px solid var(--color-divider)', padding: 'var(--space-4) 0' }}>
          <BadgeSample color="var(--tier-bronze)" rings={1} label="Bronze &mdash; single ring" />
          <BadgeSample color="var(--tier-silver)" rings={2} label="Silver &mdash; double ring" />
          <BadgeSample color="var(--tier-gold)" rings={2} dot label="Gold &mdash; double ring + dot" />
        </div>

        <h6 style={{ margin: 'var(--space-6) 0 var(--space-3)', color: 'color-mix(in srgb, var(--color-text) 60%, transparent)' }}>Palette</h6>
        <table className="table">
          <thead><tr><th>Role</th><th>Token</th><th>Hex / value</th><th>Contrast on bg</th></tr></thead>
          <tbody>
            <tr><td>Ground</td><td>--color-bg</td><td style={{ fontFamily: 'var(--font-mono)' }}>#f3f2f2</td><td>&mdash;</td></tr>
            <tr><td>Ink</td><td>--color-text</td><td style={{ fontFamily: 'var(--font-mono)' }}>#201e1d</td><td>15.9:1</td></tr>
            <tr><td>Accent</td><td>--color-accent</td><td style={{ fontFamily: 'var(--font-mono)' }}>#ec3013</td><td>3.4:1 (chrome only)</td></tr>
            <tr><td>Tier &mdash; Gold</td><td>--tier-gold</td><td style={{ fontFamily: 'var(--font-mono)' }}>accent-500</td><td>&mdash;</td></tr>
            <tr><td>Tier &mdash; Silver</td><td>--tier-silver</td><td style={{ fontFamily: 'var(--font-mono)' }}>neutral-500</td><td>&mdash;</td></tr>
            <tr><td>Tier &mdash; Bronze</td><td>--tier-bronze</td><td style={{ fontFamily: 'var(--font-mono)' }}>oklch(52% .07 55)</td><td>&mdash;</td></tr>
          </tbody>
        </table>

        <h6 style={{ margin: 'var(--space-6) 0 var(--space-3)', color: 'color-mix(in srgb, var(--color-text) 60%, transparent)' }}>Do / Don&apos;t</h6>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-4)', fontSize: 13 }}>
          <div><strong>Do</strong><ul><li>Use the badge everywhere an agent is referenced.</li><li>Keep tier construction (rings/dot) even in greyscale.</li><li>Flush-left every label.</li></ul></div>
          <div><strong>Don&apos;t</strong><ul><li>Recolor the badge to match a UI accent.</li><li>Round a corner on cards or buttons.</li><li>Center button labels.</li></ul></div>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 'var(--space-4)' }}>Download brand kit (SVG/PNG)</button>
      </main>
    </>
  );
}

function BadgeSample({ color, rings, dot, label }: { color: string; rings: number; dot?: boolean; label: string }) {
  const ring = rings === 2
    ? `inset 0 0 0 3px var(--color-bg), inset 0 0 0 5px ${color}, inset 0 0 0 8px var(--color-bg), inset 0 0 0 10px ${color}`
    : `inset 0 0 0 3px var(--color-bg), inset 0 0 0 5px ${color}`;
  return (
    <div style={{ textAlign: 'center', position: 'relative' }}>
      <span style={{ display: 'inline-block', width: 56, height: 56, borderRadius: '50%', boxShadow: ring }} />
      {dot && <span style={{ position: 'absolute', top: '50%', left: '50%', width: 8, height: 8, marginTop: -4, marginLeft: -4, borderRadius: '50%', background: color }} />}
      <div style={{ fontSize: 11, marginTop: 6 }} dangerouslySetInnerHTML={{ __html: label }} />
    </div>
  );
}

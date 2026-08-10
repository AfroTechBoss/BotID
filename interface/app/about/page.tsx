
export default function About() {
  return (
    <>
      {/* Full width. Where the width would otherwise buy nothing but longer lines, it buys columns
          instead — the four attacks sit side by side rather than stacked in a narrow rail, so the
          page fills the screen and no line of body copy gets longer than it was before. */}
      <main style={{ padding: 'var(--space-8) var(--space-6)' }}>
        <h1 style={{ fontSize: 28 }}>About BotID</h1>
        <p className="measure">Autonomous agents that manage capital get a bonded identity, a verifiable record of what they executed, and a reputation score earned from settled economic outcomes. DeFi protocols gate capital on that score through one read call.</p>
        <h3>Four attacks it prevents</h3>
        <div className="hr" />
        {/* auto-fit rather than a fixed count: at 1490px this is four across, and it collapses to
            three, two and one on the way down without a media query. 260px is the floor because
            below that the headings start wrapping mid-phrase. */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 'var(--space-6)', alignItems: 'start' }}>
          {[
            ['Sybil reputation', "Reputation is bonded to capital, not to a free identity \u2014 spinning up new agents doesn't manufacture trust."],
            ['Unfalsifiable claims', 'Every execution is attested \u2014 by bond, enclave, or proof \u2014 and challengeable within a window before it finalizes.'],
            ['Score inflation', 'Score moves only on settled outcomes, weighted by capital at risk \u2014 never on proof validity alone.'],
            ['Liveness faults going unpunished', 'A commissioned execution that never delivers is a fault, tracked separately from score and never smoothed away.'],
          ].map(([t, d]) => (
            <div key={t}><h4 style={{ marginBottom: 2 }}>{t}</h4><p style={{ margin: 0 }}>{d}</p></div>
          ))}
        </div>
        <div className="hr" />
        <p className="measure">The interface is operated independently of the protocol, which runs on its own regardless of whether this site does. See <a href="/docs">docs</a>, <a href="/security">security</a> and <a href="/legal/terms">terms</a>.</p>
      </main>
    </>
  );
}

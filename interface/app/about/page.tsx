
export default function About() {
  return (
    <>
      <main className="measure" style={{ padding: 'var(--space-8) var(--space-6)' }}>
        <h1 style={{ fontSize: 28 }}>About BotID</h1>
        <p>Autonomous agents that manage capital get a bonded identity, a verifiable record of what they executed, and a reputation score earned from settled economic outcomes. DeFi protocols gate capital on that score through one read call.</p>
        <h3>Four attacks it prevents</h3>
        <div className="hr" />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
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
        <p>The interface is operated independently of the protocol, which runs on its own regardless of whether this site does. See <a href="/docs">docs</a>, <a href="/security">security</a> and <a href="/legal/terms">terms</a>.</p>
      </main>
    </>
  );
}

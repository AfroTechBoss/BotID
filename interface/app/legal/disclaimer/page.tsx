
const NAV = [['predict', 'Not a predictor'], ['neutral', '5000 is neutral'], ['tier', 'Tier vs performance'], ['capital', 'Reputation and capital'], ['smalln', 'Small-sample noise'], ['audit', 'Not audited'], ['risk', 'Other risks']];

export default function Disclaimer() {
  return (
    <>
      {/* 1fr rather than 68ch — the column takes the screen, .legal-body keeps the measure on the
          paragraphs. Same change as privacy and terms. */}
      <div style={{ display: 'grid', gridTemplateColumns: '220px minmax(0,1fr)', gap: 'var(--space-8)', padding: 'var(--space-8) var(--space-6)', flex: 1 }}>
        <aside style={{ position: 'sticky', top: 'var(--space-6)', alignSelf: 'start', fontSize: 13, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {NAV.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}
        </aside>
        <main className="legal-body">
          <h1 style={{ fontSize: 28 }}>Risk disclosure</h1>
          <p className="text-muted" style={{ fontSize: 12 }}>Last updated Aug 9, 2026</p>
          <p>A product that publishes a number that looks like a credit score, next to money, invites exactly one misreading. This page is written against that misreading, directly.</p>
          <h3 id="predict">A score measures settled adherence; it does not predict</h3>
          <p>A 9,000-score agent can lose money tomorrow. The score reflects how cleanly an agent has delivered inside its own declared limits, on outcomes that have already settled.</p>
          <h3 id="neutral">5000 is neutral, not failing</h3>
          <p>Every agent starts at 5000 the moment it registers, with no track record either way.</p>
          <h3 id="tier">Verification tier is orthogonal to performance</h3>
          <p><strong>This is the single most likely misunderstanding of the entire product.</strong> A Gold proof shows the model ran exactly as registered &mdash; it says nothing about whether that model is a good one.</p>
          <h3 id="capital">Reputation is bounded by capital, and capital can be withdrawn</h3>
          <p>An agent&apos;s credit line is a function of its bond. The unbonding queue takes 21 days, after which the capital &mdash; and the credit line it supported &mdash; leaves.</p>
          <h3 id="smalln">Small-sample scores are noisy</h3>
          <p>A 9,800 score built on three settled executions carries far less information than an 8,200 built on three hundred.</p>
          <h3 id="audit">Not audited</h3>
          <p>The protocol&apos;s contracts are not audited as of this writing. See <a href="/security">security</a> for the current status.</p>
          <h3 id="risk">Other risks</h3>
          <p>Smart-contract risk. Oracle and publisher-quorum risk. Chain-liveness risk. Key-management risk. None of these are reduced by a high score.</p>
        </main>
      </div>
    </>
  );
}

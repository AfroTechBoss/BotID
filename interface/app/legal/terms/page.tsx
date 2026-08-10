
const NAV = [['what', 'What this is'], ['custody', 'No custody'], ['eligibility', 'Eligibility'], ['use', 'Acceptable use'], ['advice', 'No advice'], ['thirdcontent', 'Third-party content'], ['warranty', 'No warranty'], ['legal', 'Indemnity & law'], ['term', 'Termination']];

export default function Terms() {
  return (
    <>
      {/* 1fr rather than 68ch — the column takes the screen, .legal-body keeps the measure on the
          paragraphs. Same change as privacy and the risk disclosure. */}
      <div style={{ display: 'grid', gridTemplateColumns: '220px minmax(0,1fr)', gap: 'var(--space-8)', padding: 'var(--space-8) var(--space-6)', flex: 1 }}>
        <aside style={{ position: 'sticky', top: 'var(--space-6)', alignSelf: 'start', fontSize: 13, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {NAV.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}
        </aside>
        <main className="legal-body">
          <h1 style={{ fontSize: 28 }}>Terms of service</h1>
          <p className="text-muted" style={{ fontSize: 12 }}>Last updated Aug 9, 2026</p>
          <h3 id="what">What this is</h3>
          <p>An interface. The protocol &mdash; the contracts that hold bonds, route executions, and score outcomes &mdash; runs on BOT Chain whether or not this website is reachable.</p>
          <h3 id="custody">No custody</h3>
          <p>The interface never holds funds or private keys. Every transaction is composed here and signed by your own wallet, then sent directly to the contracts.</p>
          <h3 id="eligibility">Eligibility</h3>
          <p>By using this interface you represent that you are of legal age, not subject to sanctions, and not accessing this from a prohibited jurisdiction.</p>
          <h3 id="use">Acceptable use</h3>
          <p>No exploiting a vulnerability in the protocol or interface, no interference, no scraping beyond documented endpoints, no impersonating a registered agent.</p>
          <h3 id="advice">No advice</h3>
          <p><strong>Scores are not investment advice, not credit ratings in the regulatory sense, and not a guarantee of future behaviour.</strong> See the <a href="/legal/disclaimer">risk disclosure</a>.</p>
          <h3 id="thirdcontent">Third-party content</h3>
          <p>Agent metadata, feed data, and consumer-reported outcomes originate outside the interface. We display this data; we do not endorse it.</p>
          <h3 id="warranty">No warranty, limitation of liability</h3>
          <p>The interface is provided as-is, to the maximum extent your jurisdiction permits.</p>
          <h3 id="legal">Indemnity, governing law, disputes, changes</h3>
          <p>You agree to indemnify us against claims arising from your breach of these terms. Material changes move the &quot;Last updated&quot; date above.</p>
          <h3 id="term">Termination</h3>
          <p>We can withdraw your access to this website. We cannot withdraw your access to the protocol &mdash; nobody can.</p>
        </main>
      </div>
    </>
  );
}


export default function Docs() {
  return (
    <>
      {/* Full width, with the four destinations across it rather than stacked. btn-block was doing
          the stacking: four full-width buttons in a 70ch rail. As a grid they stay the same size
          as each other and the row reaches both edges of the screen. */}
      <main style={{ padding: 'var(--space-8) var(--space-6)' }}>
        <h1 style={{ fontSize: 28 }}>Docs</h1>
        <p className="measure">The interface is a read-only view over BotID&apos;s on-chain state. The protocol itself &mdash; contracts, circuits, event schema &mdash; lives in the repository, not here.</p>
        <div className="hr" />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 'var(--space-2)' }}>
          <a href="#" className="btn btn-secondary btn-block">Protocol repository &rarr;</a>
          <a href="#" className="btn btn-secondary btn-block">Architecture &mdash; the four attacks it prevents &rarr;</a>
          <a href="#" className="btn btn-secondary btn-block">Contract ABIs &rarr;</a>
          <a href="#" className="btn btn-secondary btn-block">ezkl circuit spec &rarr;</a>
        </div>
      </main>
    </>
  );
}

import Nav from '@/components/Nav';
import Footer from '@/components/Footer';

export default function Docs() {
  return (
    <>
      <Nav current="/docs" />
      <main style={{ padding: 'var(--space-8) var(--space-6)', maxWidth: '70ch', flex: 1 }}>
        <h1 style={{ fontSize: 28 }}>Docs</h1>
        <p>The interface is a read-only view over BotID&apos;s on-chain state. The protocol itself &mdash; contracts, circuits, event schema &mdash; lives in the repository, not here.</p>
        <div className="hr" />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          <a href="#" className="btn btn-secondary btn-block">Protocol repository &rarr;</a>
          <a href="#" className="btn btn-secondary btn-block">Architecture &mdash; the four attacks it prevents &rarr;</a>
          <a href="#" className="btn btn-secondary btn-block">Contract ABIs &rarr;</a>
          <a href="#" className="btn btn-secondary btn-block">ezkl circuit spec &rarr;</a>
        </div>
      </main>
      <Footer />
    </>
  );
}

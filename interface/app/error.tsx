'use client';

export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 'var(--space-4)', textAlign: 'center' }}>
      <h1 style={{ fontSize: 64, margin: 0, color: 'var(--score-critical)' }}>500</h1>
      <p style={{ maxWidth: '44ch' }}>RPC request failed. This is on the connection, not the chain &mdash; retry, or check <a href="/status">status</a> for what&apos;s actually down.</p>
      <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
        <button className="btn btn-primary" onClick={() => reset()}>Retry</button>
        <a href="/status" className="btn btn-secondary">View status</a>
      </div>
    </div>
  );
}

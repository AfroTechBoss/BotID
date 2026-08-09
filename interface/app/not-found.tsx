
export default function NotFound() {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 'var(--space-4)', textAlign: 'center' }}>
      <h1 style={{ fontSize: 64, margin: 0 }}>404</h1>
      <p style={{ maxWidth: '44ch' }}>Nothing at this address. The most common miss here is a mistyped requestId &mdash; search for it below.</p>
      <div className="field" style={{ width: 340 }}><input className="input" placeholder="requestId, agent id, or address" /></div>
      <a href="/" className="btn btn-secondary">Back to overview</a>
    </div>
  );
}

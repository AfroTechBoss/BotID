
export default function Cookies() {
  return (
    <>
      <main style={{ padding: 'var(--space-8) var(--space-6)', maxWidth: '68ch', flex: 1 }}>
        <h1 style={{ fontSize: 28 }}>Cookies &amp; local storage</h1>
        <p className="text-muted" style={{ fontSize: 12 }}>Last updated Aug 9, 2026</p>
        <p>No tracking cookies. No advertising cookies. No consent banner, because there is nothing here to consent to.</p>
        <h3>Local storage, in full</h3>
        <table className="table">
          <thead><tr><th>Key</th><th>Purpose</th><th>Sent to a server?</th></tr></thead>
          <tbody>
            <tr><td style={{ fontFamily: 'var(--font-mono)' }}>botid.theme</td><td>Display preference</td><td>No</td></tr>
            <tr><td style={{ fontFamily: 'var(--font-mono)' }}>botid.feed_paused</td><td>Live feed pause state</td><td>No</td></tr>
            <tr><td style={{ fontFamily: 'var(--font-mono)' }}>botid.watchlist</td><td>Pinned agent ids</td><td>No</td></tr>
            <tr><td style={{ fontFamily: 'var(--font-mono)' }}>botid.rpc_endpoint</td><td>Last-used RPC override</td><td>No</td></tr>
          </tbody>
        </table>
        <h3>If that ever changes</h3>
        <p>A consent banner, if it becomes necessary, will be a bottom-anchored bar with equal-weight Accept and Decline buttons &mdash; no scrim, no scroll lock, never covering content on mobile.</p>
      </main>
    </>
  );
}

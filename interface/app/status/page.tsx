
export default function Status() {
  return (
    <>
      {/* Two tables and one line of prose — table page, so no cap. */}
      <main style={{ padding: 'var(--space-8) var(--space-6)' }}>
        <h1 style={{ fontSize: 28 }}>Status</h1>
        <p className="text-muted" style={{ fontSize: 12 }}>Measured from this browser, not a global claim.</p>
        <div className="table-scroll">
          <table className="table" style={{ marginTop: 'var(--space-4)' }}>
            <tbody>
              <tr><td>Block height</td><td style={{ fontFamily: 'var(--font-mono)', textAlign: 'right' }}>8,412,912</td></tr>
              <tr><td>Indexer head</td><td style={{ fontFamily: 'var(--font-mono)', textAlign: 'right', color: 'var(--score-good)' }}>8,412,912 &middot; 0.4s lag</td></tr>
              <tr><td>RPC latency</td><td style={{ fontFamily: 'var(--font-mono)', textAlign: 'right' }}>112ms</td></tr>
              <tr><td>WebSocket</td><td style={{ textAlign: 'right' }}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--live)' }} />connected</span></td></tr>
              <tr><td>Verifier (ZkAdapter)</td><td style={{ textAlign: 'right', color: 'var(--score-good)' }}>reachable</td></tr>
            </tbody>
          </table>
        </div>
        <h6 style={{ color: 'var(--text-muted)', margin: 'var(--space-6) 0 var(--space-2)' }}>Last observed event per contract</h6>
        <div className="table-scroll">
          <table className="table">
            <thead><tr><th>Contract</th><th>Event</th><th>Block</th></tr></thead>
            <tbody>
              <tr><td>ExecutionRouter</td><td>ExecutionSettled</td><td style={{ fontFamily: 'var(--font-mono)' }}>8,412,900</td></tr>
              <tr><td>ReputationEngine</td><td>ScoreUpdated</td><td style={{ fontFamily: 'var(--font-mono)' }}>8,412,900</td></tr>
              <tr><td>ZkAdapter</td><td>VerifierSet</td><td style={{ fontFamily: 'var(--font-mono)' }}>8,120,441</td></tr>
            </tbody>
          </table>
        </div>
      </main>
    </>
  );
}

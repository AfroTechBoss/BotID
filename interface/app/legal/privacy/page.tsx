
const NAV = [['collect', 'What we collect'], ['browser', 'Your browser'], ['chain', 'On-chain data'], ['local', 'Local storage'], ['analytics', 'Analytics'], ['alerts', 'Alerts'], ['cookies', 'Cookies'], ['third', 'Third parties'], ['rights', 'Your rights'], ['children', 'Children'], ['changes', 'Changes & contact']];

export default function Privacy() {
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: '220px minmax(0,68ch)', gap: 'var(--space-8)', padding: 'var(--space-8) var(--space-6)', flex: 1 }}>
        <aside style={{ position: 'sticky', top: 'var(--space-6)', alignSelf: 'start', fontSize: 13, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {NAV.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}
        </aside>
        <main>
          <h1 style={{ fontSize: 28 }}>Privacy policy</h1>
          <p className="text-muted" style={{ fontSize: 12 }}>Last updated Aug 9, 2026</p>
          <p>What this interface collects is unusually little for a product in this space, and that is a genuine selling point, not boilerplate to skim past. There is no account, no sign-up, no email address on file unless you deliberately give us one to receive an alert, and we do not collect your wallet address ourselves.</p>

          <h3 id="collect">What we collect</h3>
          <p>Nothing tied to an identity by default. If you configure a score-threshold alert, we store the webhook URL you gave us, the threshold you set, and the agent id you are watching &mdash; nothing more.</p>

          <h3 id="browser">What your browser sends anyway</h3>
          <p>Your RPC provider sees your IP address and the specific calls you make while this page reads chain state. Your wallet provider sees the connection request the moment you click &quot;Connect wallet.&quot; Neither of those is us.</p>

          <h3 id="chain">On-chain data</h3>
          <p><strong>Anything you transact through the protocol is public, permanent, and outside anyone&apos;s control &mdash; including ours.</strong></p>

          <h3 id="local">Local storage</h3>
          <table className="table">
            <thead><tr><th>Key</th><th>Purpose</th></tr></thead>
            <tbody>
              <tr><td style={{ fontFamily: 'var(--font-mono)' }}>botid.theme</td><td>Display preference</td></tr>
              <tr><td style={{ fontFamily: 'var(--font-mono)' }}>botid.feed_paused</td><td>Live feed pause state</td></tr>
              <tr><td style={{ fontFamily: 'var(--font-mono)' }}>botid.watchlist</td><td>Pinned agent ids</td></tr>
              <tr><td style={{ fontFamily: 'var(--font-mono)' }}>botid.rpc_endpoint</td><td>Last-used RPC override</td></tr>
            </tbody>
          </table>

          <h3 id="analytics">Analytics</h3>
          <p>If we run analytics at all, it is cookieless, aggregate, and never joined to a wallet address.</p>

          <h3 id="alerts">Alerts</h3>
          <p>See the alerts panel in the <a href="/portal">portal</a> for whether alerts are client-side only or backed by a server today.</p>

          <h3 id="cookies">Cookies</h3>
          <p>See the dedicated <a href="/legal/cookies">cookie notice</a> for the full local-storage table.</p>

          <h3 id="third">Third parties</h3>
          <table className="table">
            <thead><tr><th>Party</th><th>What they see</th></tr></thead>
            <tbody>
              <tr><td>RPC provider</td><td>Your IP, the calls this page makes on your behalf</td></tr>
              <tr><td>WalletConnect / wallet extension</td><td>The connection request and any signature you approve</td></tr>
              <tr><td>Analytics (if enabled)</td><td>Aggregate, cookieless page-view counts</td></tr>
              <tr><td>Hosting provider</td><td>Standard request logs for serving static files</td></tr>
            </tbody>
          </table>

          <h3 id="rights">Your rights</h3>
          <p>Access, correction, deletion or portability of anything we hold &mdash; which is close to nothing. On-chain records cannot be deleted by anyone.</p>

          <h3 id="children">Children</h3>
          <p>This interface is not directed at, and is not intended for use by, anyone under 18.</p>

          <h3 id="changes">Changes and contact</h3>
          <p>Material changes move the &quot;Last updated&quot; date above. Questions: <a href="mailto:privacy@botid.example">privacy@botid.example</a>.</p>
        </main>
      </div>
    </>
  );
}

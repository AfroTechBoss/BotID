
export default function Security() {
  return (
    <>
      <main className="measure" style={{ padding: 'var(--space-8) var(--space-6)' }}>
        <h1 style={{ fontSize: 28 }}>Security</h1>
        <div style={{ border: '2px solid var(--score-critical)', color: 'var(--score-critical)', padding: 'var(--space-3)', fontWeight: 600, margin: 'var(--space-4) 0' }}>
          Not audited. Intended scope for a first audit: RequestManager, ScoreRegistry, ZkAdapter. No date set yet.
        </div>

        <h6 style={{ color: 'color-mix(in srgb, var(--color-text) 60%, transparent)', margin: 'var(--space-6) 0 var(--space-2)' }}>Deployed contracts</h6>
        <p style={{ fontSize: 13 }}>This table is load-bearing: it is the canonical answer to &quot;is this the real BotID.&quot; Each address links to a verified explorer source page.</p>
        <table className="table">
          <thead><tr><th>Contract</th><th>Network</th><th>Address</th></tr></thead>
          <tbody>
            <tr><td>RequestManager</td><td>BOT testnet</td><td><a href="#" style={{ fontFamily: 'var(--font-mono)' }}>0x4a91&hellip;e02c</a></td></tr>
            <tr><td>ScoreRegistry</td><td>BOT testnet</td><td><a href="#" style={{ fontFamily: 'var(--font-mono)' }}>0x7bd3&hellip;119a</a></td></tr>
            <tr><td>ZkAdapter</td><td>BOT testnet</td><td><a href="#" style={{ fontFamily: 'var(--font-mono)' }}>0x9c1e&hellip;04f2</a></td></tr>
            <tr><td>BondVault</td><td>BOT testnet</td><td><a href="#" style={{ fontFamily: 'var(--font-mono)' }}>0x2d6f&hellip;a877</a></td></tr>
          </tbody>
        </table>

        <h6 style={{ color: 'color-mix(in srgb, var(--color-text) 60%, transparent)', margin: 'var(--space-6) 0 var(--space-2)' }}>Verifier &amp; model registrations</h6>
        <p style={{ fontSize: 13 }}>Read live from ZkAdapter &mdash; a page that reads its own claims off chain is on-brand.</p>
        <table className="table">
          <thead><tr><th>Model commitment</th><th>Verifier</th><th>Input scale</th></tr></thead>
          <tbody><tr><td style={{ fontFamily: 'var(--font-mono)' }}>0x8f3a&hellip;</td><td style={{ fontFamily: 'var(--font-mono)' }}>0x9c1e&hellip;</td><td>8 bits</td></tr></tbody>
        </table>

        <h6 style={{ color: 'color-mix(in srgb, var(--color-text) 60%, transparent)', margin: 'var(--space-6) 0 var(--space-2)' }}>Bug bounty</h6>
        <p>None yet. When a program launches, its scope, severity tiers, rewards and safe-harbour terms will be published here in full before any submission is expected.</p>

        <h6 style={{ color: 'color-mix(in srgb, var(--color-text) 60%, transparent)', margin: 'var(--space-6) 0 var(--space-2)' }}>Responsible disclosure</h6>
        <p>Contact <a href="mailto:security@botid.example">security@botid.example</a>. A PGP key is available on request for anything sensitive.</p>

        <h6 style={{ color: 'color-mix(in srgb, var(--color-text) 60%, transparent)', margin: 'var(--space-6) 0 var(--space-2)' }}>Dependency &amp; infrastructure disclosure</h6>
        <p>Frontends are the soft target in this industry, so here is who holds the keys: RPC access runs through BOT Chain&apos;s public endpoints, which we do not operate. Hosting is static with no server-side secrets. Production deploy access is limited to the interface operator named in <a href="/about">about</a>.</p>

        <h6 style={{ color: 'color-mix(in srgb, var(--color-text) 60%, transparent)', margin: 'var(--space-6) 0 var(--space-2)' }}>Chain-level audits &mdash; not ours</h6>
        <p>CertiK has audited BOT Chain itself, its DEX and its bridge. <strong>Those audits do not cover BotID&apos;s contracts</strong> &mdash; see the unaudited notice at the top of this page for our own status.</p>
      </main>
    </>
  );
}

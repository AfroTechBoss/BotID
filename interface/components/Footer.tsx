import Link from 'next/link';

export default function Footer({ networkLabel = 'testnet' }: { networkLabel?: string }) {
  return (
    <footer style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 'var(--space-6)', padding: 'var(--space-6)', borderTop: '2px solid var(--color-divider)', fontSize: 12 }}>
      <div>
        <h6 style={{ marginBottom: 8 }}>Protocol</h6>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Link href="/docs">Docs</Link><Link href="/docs">Repo</Link><Link href="/security">Contracts</Link><Link href="/docs">Architecture</Link>
        </div>
      </div>
      <div>
        <h6 style={{ marginBottom: 8 }}>Interface</h6>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Link href="/status">Status</Link><Link href="/brand">Brand</Link><Link href="/about">About</Link>
        </div>
      </div>
      <div>
        <h6 style={{ marginBottom: 8 }}>Legal</h6>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Link href="/legal/privacy">Privacy</Link><Link href="/legal/terms">Terms</Link>
          <Link href="/legal/disclaimer">Disclaimer</Link><Link href="/legal/cookies">Cookies</Link><Link href="/security">Security</Link>
        </div>
      </div>
      <div style={{ gridColumn: '1/-1', display: 'flex', justifyContent: 'space-between', color: 'color-mix(in srgb, var(--color-text) 55%, transparent)', borderTop: '1px solid var(--color-divider)', paddingTop: 'var(--space-3)', marginTop: 'var(--space-2)' }}>
        <span>{networkLabel}</span>
        <span>v0.1.0 &middot; a1b2c3d</span>
      </div>
    </footer>
  );
}

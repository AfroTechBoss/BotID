import Link from 'next/link';
import NetworkLabel from './NetworkLabel';
import ThemeToggle from './ThemeToggle';
import { readTheme } from '@/lib/theme.server';

// The network name used to be a prop defaulting to 'testnet', which meant the footer said testnet
// on every page regardless of what the nav switcher was set to — nothing ever passed the prop.
// It reads the shared network now, so there is no way to render a footer that disagrees.
export default function Footer() {
  return (
    // The column count lives in .site-footer because it has to change on a phone, where three 1fr
    // columns are 105px each and wrap "Architecture" mid-word — and a media query cannot reach an
    // inline style. auto-fit is wrong here: the bottom bar spans 1/-1, so a wider track count would
    // leave the three link groups bunched in the left half of a desktop footer.
    <footer className="site-footer" style={{ padding: 'var(--space-6)', borderTop: '2px solid var(--color-divider)', fontSize: 12 }}>
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
      <div style={{ gridColumn: '1/-1', display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 'var(--space-2) var(--space-4)', color: 'var(--text-subtle)', borderTop: '1px solid var(--color-divider)', paddingTop: 'var(--space-3)', marginTop: 'var(--space-2)' }}>
        <span><NetworkLabel /></span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)' }}>
          {/* Read here rather than threaded down from the layout: the footer is already a server
              component, and a prop would have to cross Nav and the page to get here. */}
          <ThemeToggle initial={readTheme()} />
          v0.1.0 &middot; a1b2c3d
        </span>
      </div>
    </footer>
  );
}

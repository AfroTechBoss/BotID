import Link from 'next/link';
import NetworkLabel from './NetworkLabel';
import ThemeToggle from './ThemeToggle';
import { readTheme } from '@/lib/theme.server';

const REPO = 'https://github.com/AfroTechBoss/BotID';

// The build stamp was the literal string "v0.1.0 · a1b2c3d". a1b2c3d is not a commit — it is what a
// commit looks like, which on a site whose whole argument is that you can check things is the worst
// kind of placeholder: it invites a reader to look up a revision that has never existed. Vercel sets
// this at build time; where it is unset, the stamp says so rather than inventing one.
const COMMIT = (process.env.VERCEL_GIT_COMMIT_SHA ?? '').slice(0, 7);

// The network name used to be a prop defaulting to 'testnet', which meant the footer said testnet
// on every page regardless of what the nav switcher was set to — nothing ever passed the prop.
// It reads the shared network now, so there is no way to render a footer that disagrees.
export default function Footer() {
  return (
    // Nothing about the footer's size is set here any more — padding, type scale, column count and
    // the gaps between the groups all live in .site-footer, because every one of them has to change
    // on a phone and a media query cannot reach an inline style. Three columns at every width is the
    // point: the footer is the last thing on the page, and a group that drops to a second row reads
    // as a separate block rather than a peer of the two above it.
    <footer className="site-footer">
      <div>
        <h6>Protocol</h6>
        <div className="footer-links">
          {/* Three of these four used to point at /docs, which makes a four-item column that is
              really a one-item column — a corridor of doors that all open into the same room. Repo
              goes to the repository, Architecture to the section of the docs that is actually the
              architecture, and Licence to the terms for using any of it. */}
          <Link href="/docs">Docs</Link>
          <a href={REPO} target="_blank" rel="noopener noreferrer">Repo</a>
          <Link href="/security">Contracts</Link>
          <Link href="/docs#lifecycle">Architecture</Link>
          <Link href="/docs#license">Licence</Link>
        </div>
      </div>
      <div>
        <h6>Interface</h6>
        <div className="footer-links">
          <Link href="/status">Status</Link><Link href="/brand">Brand</Link><Link href="/about">About</Link>
        </div>
      </div>
      <div>
        <h6>Legal</h6>
        <div className="footer-links">
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
          v0.1.0 {COMMIT ? <>&middot; <a href={`${REPO}/commit/${COMMIT}`} target="_blank" rel="noopener noreferrer">{COMMIT}</a></> : '· local build'}
        </span>
      </div>
    </footer>
  );
}

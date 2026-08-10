'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import NetworkSelect from './NetworkSelect';
import ConnectWalletButton from './ConnectWalletButton';

// Mounted once in the root layout. It derives the active link from the URL rather than taking a
// `current` prop, so a new route cannot forget to tell the nav where it is.
//
// There is no Verify entry: /verify/[requestId] has no meaning without a request, and a nav item
// that needs a placeholder id is a nav item that should not exist. It is reached from an
// execution, which is where a reader has one.
const LINKS: [string, string][] = [
  ['/', 'Overview'],
  ['/agents', 'Agents'],
  ['/executions', 'Executions'],
  ['/portal', 'Portal'],
  ['/docs', 'Docs'],
];

export default function Nav() {
  const pathname = usePathname() || '/';
  const isCurrent = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));

  return (
    <nav className="nav">
      {/* Wordmark only. The concentric ring that used to sit beside it was a fourth thing drawing
          rings — after BotIdBadge, the live dots and the network dot — and being decorative rather
          than carrying state it just diluted the ones that mean something. */}
      <Link href="/" className="nav-brand" style={{ color: 'inherit', textDecoration: 'none' }}>
        BotID Protocol
      </Link>
      {/* The links and the controls are each wrapped in one box rather than sitting loose in the
          nav's flex row. Loose, they were seven siblings that could only ever be one line: below
          about 700px the row was 682px wide inside a 375px viewport and every page on the site
          scrolled sideways. Grouped, the menu wraps to a second row as a unit — see the
          media query in globals.css, which also restates --nav-h for the taller header. */}
      <div className="nav-links">
        {LINKS.map(([href, label]) => (
          <Link key={href} href={href} aria-current={isCurrent(href) ? 'page' : undefined}>
            {label}
          </Link>
        ))}
      </div>
      <div className="nav-actions">
        <NetworkSelect />
        <ConnectWalletButton />
      </div>
    </nav>
  );
}

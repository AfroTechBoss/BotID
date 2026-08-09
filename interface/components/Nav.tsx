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
      <Link href="/" className="nav-brand" style={{ color: 'inherit', textDecoration: 'none' }}>
        <span
          aria-hidden="true"
          style={{
            width: 14, height: 14, borderRadius: '50%', border: '2px solid var(--color-text)',
            boxShadow: 'inset 0 0 0 3px var(--color-bg), inset 0 0 0 4px var(--color-text)',
            display: 'inline-block',
          }}
        />
        BOTID
      </Link>
      {LINKS.map(([href, label]) => (
        <Link key={href} href={href} aria-current={isCurrent(href) ? 'page' : undefined}>
          {label}
        </Link>
      ))}
      <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
        <NetworkSelect />
        <ConnectWalletButton />
      </span>
    </nav>
  );
}

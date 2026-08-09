import Link from 'next/link';
import NetworkSelect from './NetworkSelect';
import ConnectWalletButton from './ConnectWalletButton';

const LINKS = [
  ['/', 'Overview'], ['/agents', 'Leaderboard'], ['/agents/7', 'Agents'],
  ['/executions', 'Executions'], ['/verify/sample', 'Verify'], ['/portal', 'Portal'],
];

export default function Nav({ current }: { current?: string }) {
  return (
    <nav className="nav">
      <span className="nav-brand">
        <span style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid var(--color-text)', boxShadow: 'inset 0 0 0 3px var(--color-bg), inset 0 0 0 4px var(--color-text)', display: 'inline-block' }} />
        BOTID
      </span>
      {LINKS.map(([href, label]) => (
        <Link key={href} href={href} aria-current={current === href ? 'page' : undefined}>{label}</Link>
      ))}
      <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
        <NetworkSelect />
        <ConnectWalletButton />
      </span>
    </nav>
  );
}

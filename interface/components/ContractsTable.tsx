'use client';
import { useNetwork } from '@/lib/network';
import { CONTRACTS } from '@/lib/contracts';

// Scoped as tightly as NetworkLabel, and for the same reason: the security page is otherwise
// static prose, and making the whole route a client component to read one value would ship all of
// that copy to the browser for nothing.
//
// The Network column is gone. Every row named the same network, so it repeated a single fact four
// times and read as though the rows could differ — which is exactly why it survived hardcoded as
// "BOT testnet" while the switcher said otherwise. The network is a property of the table, so it
// is stated once, in the caption, where there is room to name the chain id too. That id is worth
// showing on this page in particular: it is the part a reader can check against their wallet.
export default function ContractsTable() {
  const { network } = useNetwork();
  const rows = CONTRACTS[network.id];
  // Counted over BotID's own deployments, not over rows. The bond token is present on every
  // network whether or not we have deployed anything there, so `rows.length` answers a different
  // question than the one this notice asks.
  const deployed = rows.some((c) => !c.dependency);

  if (!deployed) {
    return (
      <p
        style={{ border: '2px solid var(--color-divider)', padding: 'var(--space-3)', fontSize: 13 }}
        // Announced, because switching network changes this out from under a reader who may not
        // have been looking at this part of the page.
        role="status"
      >
        No BotID contracts are deployed on {network.name}. Any address claiming to be BotID on{' '}
        {network.name} is not ours.
      </p>
    );
  }

  return (
    <div className="table-scroll">
      <table className="table">
        <caption style={{ captionSide: 'top', textAlign: 'left', fontSize: 13, paddingBottom: 'var(--space-2)' }}>
          Deployed on {network.name}{' '}
          <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            chain {network.chainId}
          </span>
        </caption>
        <thead>
          <tr><th>Contract</th><th>Address</th></tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.name}>
              <td>
                {c.name}
                {/* Said on the row rather than in a footnote. A reader scanning for "is this
                    BotID" reads one line at a time, and USDT sitting unlabelled among eight of
                    our addresses reads as the ninth. */}
                {c.dependency && (
                  <span className="text-muted" style={{ fontSize: 11 }}> &mdash; external, not deployed by BotID</span>
                )}
              </td>
              <td>
                {/* Was href="#", which on this page is worse than no link: an address that looks
                    checkable and goes nowhere is the same gesture a fake would make. The base
                    comes off `network`, the same object that captions the table, so the link
                    cannot point at a chain other than the one named above it. */}
                <a
                  href={`${network.explorer}/address/${c.address}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontFamily: 'var(--font-mono)' }}
                >
                  {c.address}
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

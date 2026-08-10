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

  if (rows.length === 0) {
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
              <td>{c.name}</td>
              <td><a href="#" style={{ fontFamily: 'var(--font-mono)' }}>{c.address}</a></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

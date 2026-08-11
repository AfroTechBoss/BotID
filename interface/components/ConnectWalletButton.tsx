'use client';
import { useState } from 'react';
import { useWallet, shortAddress, networkOf } from '@/lib/wallet';
import { useNetwork } from '@/lib/network';

/**
 * Three states, and the middle one is the point: connected but on the wrong chain.
 *
 * A wallet sitting on Ethereum mainnet while the nav says Bohr will sign a transaction that goes
 * nowhere near our contracts, and the failure surfaces as an unrelated revert or as a transaction
 * to an address that holds no code. So the button stops being a connect button and becomes the fix
 * for that, which is the only action worth offering in that state.
 */
export default function ConnectWalletButton() {
  const { address, connecting, connect, disconnect, hasProvider, onSelectedChain, walletChainId, switchToSelected, error } = useWallet();
  const { network } = useNetwork();
  const [open, setOpen] = useState(false);

  if (!address) {
    return (
      // Positioned, not stacked. This was a two-item flex column, which made the whole control
      // taller than the nav row — so the row centred it, the button rose above the nav's top edge
      // and the message hung below its bottom border. Only the button is in flow now; the message
      // floats under it like the account dropdown does, and the nav's height stops depending on
      // whether a wallet happens to be installed.
      <span style={{ position: 'relative', display: 'inline-block' }}>
        <button className="btn btn-secondary" onClick={connect} disabled={connecting}>
          {connecting ? 'Check your wallet…' : 'Connect wallet'}
        </button>
        {/* Only after a click. Rendering "no wallet found" on load would be the first thing a
            visitor reads, and it is not a problem until they try to do something. */}
        {error && !hasProvider && (
          <span
            style={{
              position: 'absolute', right: 0, top: 'calc(100% + 4px)', zIndex: 20,
              background: 'var(--color-surface)', border: '1px solid var(--score-critical)',
              padding: 'var(--space-2)', width: 220, textAlign: 'right',
              fontSize: 11, color: 'var(--score-critical)',
            }}
          >
            {error}
          </span>
        )}
      </span>
    );
  }

  if (!onSelectedChain) {
    const on = networkOf(walletChainId);
    return (
      <button
        className="btn btn-secondary"
        onClick={switchToSelected}
        style={{ borderColor: 'var(--score-critical)', color: 'var(--score-critical)' }}
        title={`Wallet is on ${on ? (on === 'testnet' ? 'Bohr Testnet' : 'BOT Chain') : `chain ${walletChainId ?? '?'}`}; this page is showing ${network.name}`}
      >
        Switch to {network.name}
      </button>
    );
  }

  return (
    <span style={{ position: 'relative', display: 'inline-block' }}>
      <button className="btn btn-secondary select-trigger" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span style={{ fontFamily: 'var(--font-mono)' }}>{shortAddress(address)}</span>
      </button>
      {open && (
        <div
          style={{
            position: 'absolute', right: 0, top: 'calc(100% + 4px)', zIndex: 20,
            background: 'var(--color-surface)', border: '1px solid var(--color-divider)',
            padding: 'var(--space-2)', minWidth: 200,
          }}
        >
          <div className="text-muted" style={{ fontSize: 11, fontFamily: 'var(--font-mono)', wordBreak: 'break-all', marginBottom: 'var(--space-2)' }}>
            {address}
          </div>
          <button
            className="btn btn-secondary btn-block"
            onClick={() => { disconnect(); setOpen(false); }}
          >
            Forget this account
          </button>
          {/* Named for what it does. The site cannot revoke its own permission — that lives in the
              wallet — so calling this "disconnect" would promise something it does not do. */}
          <p className="text-muted" style={{ fontSize: 11, margin: '6px 0 0' }}>
            Clears it from this tab only. Revoke the site&apos;s access in your wallet.
          </p>
        </div>
      )}
    </span>
  );
}

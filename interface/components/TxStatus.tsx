'use client';
import { useNetwork } from '@/lib/network';
import { explorerLink } from '@/lib/chain';
import type { TxState } from '@/lib/tx';

/**
 * One line of transaction feedback, with the hash linked the moment there is one.
 *
 * The hash is shown during `pending`, not withheld until success. A transaction that is taking
 * longer than expected is exactly when someone wants to go and look at it on the explorer, and
 * that is also the only moment the UI cannot tell them anything more.
 */
export default function TxStatus({ state, idleHint }: { state: TxState; idleHint?: string }) {
  const { network } = useNetwork();

  if (state.phase === 'idle') {
    return idleHint ? <p className="text-muted" style={{ fontSize: 11, margin: 0 }}>{idleHint}</p> : null;
  }

  const color =
    state.phase === 'error' ? 'var(--score-critical)' : state.phase === 'success' ? 'var(--score-strong)' : 'var(--text-muted)';

  const text =
    state.phase === 'signing' ? `${state.step ?? 'Transaction'} — confirm in your wallet`
    : state.phase === 'pending' ? `${state.step ?? 'Transaction'} — waiting for it to be mined`
    : state.phase === 'success' ? 'Confirmed on chain.'
    : state.error;

  return (
    <p style={{ fontSize: 11, margin: 0, color, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
      <span>{text}</span>
      {state.hash && (
        <a href={explorerLink(network.id, 'tx', state.hash)} target="_blank" rel="noopener noreferrer" style={{ fontFamily: 'var(--font-mono)' }}>
          {state.hash.slice(0, 10)}…
        </a>
      )}
    </p>
  );
}

'use client';
import { useCallback, useState } from 'react';
import type { Hash } from 'viem';
import { publicClient } from './chain';
import { useNetwork } from './network';
import { walletMessage } from './wallet';

export type TxPhase = 'idle' | 'signing' | 'pending' | 'success' | 'error';

export interface TxState {
  phase: TxPhase;
  hash: Hash | undefined;
  error: string | undefined;
  /** The label of whichever step is running, when a flow has more than one. */
  step: string | undefined;
}

const IDLE: TxState = { phase: 'idle', hash: undefined, error: undefined, step: undefined };

/**
 * Runs a write and waits for it to be mined, as one piece of state a button can render.
 *
 * The distinction that matters here is `signing` versus `pending`. Between the click and the
 * wallet popup there is a gap where nothing has happened yet and the user has not been asked
 * anything; and after they sign there is a second gap, ~0.75s here but occasionally much longer,
 * where the transaction exists but nothing has changed. Collapsing both into one "loading" is how
 * people click twice and sign twice — and two `registerAgent` calls is two agents and two bonds.
 *
 * `run` takes a list of steps because approve-then-call is the common shape and the two halves
 * should not each own their own spinner. A step that returns undefined is skipped, which is how
 * "approve only if the allowance is short" stays a decision in the caller rather than a flag here.
 */
export function useTx() {
  const { network } = useNetwork();
  const [state, setState] = useState<TxState>(IDLE);

  const reset = useCallback(() => setState(IDLE), []);

  const run = useCallback(
    async (steps: { label: string; send: () => Promise<Hash | undefined> }[]): Promise<boolean> => {
      const client = publicClient(network.id);
      for (const { label, send } of steps) {
        setState({ phase: 'signing', hash: undefined, error: undefined, step: label });
        let hash: Hash | undefined;
        try {
          hash = await send();
        } catch (e) {
          setState({ phase: 'error', hash: undefined, error: walletMessage(e), step: label });
          return false;
        }
        if (!hash) continue; // step decided it was unnecessary

        setState({ phase: 'pending', hash, error: undefined, step: label });
        try {
          const receipt = await client.waitForTransactionReceipt({ hash });
          // A mined transaction is not a successful one. Without this check a reverted call shows
          // a green tick and a hash, and the user goes looking for an agent that was never made.
          if (receipt.status !== 'success') {
            setState({ phase: 'error', hash, error: `${label} reverted on chain.`, step: label });
            return false;
          }
        } catch (e) {
          setState({ phase: 'error', hash, error: walletMessage(e), step: label });
          return false;
        }
      }
      setState((s) => ({ phase: 'success', hash: s.hash, error: undefined, step: undefined }));
      return true;
    },
    [network.id]
  );

  return { ...state, run, reset, busy: state.phase === 'signing' || state.phase === 'pending' };
}

'use client';
import { useState } from 'react';
import { inputAttestorAbi } from '@abi/InputAttestor';
import { publicClient } from '@/lib/chain';
import type { NetworkId } from '@/lib/network';

// The only interactive part of the receipt. It is split out so the page itself can stay a server
// component and export generateMetadata — a shared link has to unfurl with the agent and the
// notional in it, and a client component cannot produce that.
//
// It used to set a boolean and print "✓ matches inputCommitment" next to a hardcoded hash. That is
// theatre: the button asserted the check it was named after without performing it, on the one page
// whose entire argument is that you do not have to take our word for anything. It now recomputes
// the commitment by calling `InputAttestor.commit` — the contract's own function, over the feeds
// decoded out of the delivery transaction — and prints whatever comes back, including when it
// disagrees. A mismatch is a genuine finding and is rendered as one.
//
// The recompute goes through the contract rather than through a keccak in this file for the same
// reason the policy endpoint calls `meetsPolicy` rather than reimplementing it: a second
// implementation of a hash convention is a second thing that can drift, and the one that would
// look authoritative on screen is the one nobody checked.

interface FeedRow {
  feedId: `0x${string}`;
  valueHash: `0x${string}`;
  /** Seconds, as a string: a bigint cannot cross the server/client boundary as a prop. */
  timestamp: string;
}

type Result =
  | { kind: 'match'; commitment: string }
  | { kind: 'mismatch'; commitment: string }
  | { kind: 'error'; message: string };

export default function RecomputeCommitment({
  network,
  attestor,
  feeds,
  expected,
}: {
  network: NetworkId;
  attestor: `0x${string}`;
  feeds: FeedRow[];
  expected: string;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>();

  const recompute = async () => {
    setBusy(true);
    setResult(undefined);
    try {
      const commitment = await publicClient(network).readContract({
        address: attestor,
        abi: inputAttestorAbi,
        functionName: 'commit',
        args: [feeds.map((f) => ({ feedId: f.feedId, valueHash: f.valueHash, timestamp: BigInt(f.timestamp), signatures: [] }))],
      });
      setResult({
        kind: commitment.toLowerCase() === expected.toLowerCase() ? 'match' : 'mismatch',
        commitment,
      });
    } catch (e) {
      // The node's own message, not a paraphrase. "Could not recompute" tells a reader nothing
      // they can act on, and this is a page for readers who intend to act on it.
      setResult({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button className="btn btn-secondary" style={{ marginTop: 'var(--space-2)' }} onClick={recompute} disabled={busy}>
        {busy ? 'Recomputing…' : 'Recompute commitment'}
      </button>
      {result?.kind === 'match' && (
        <div style={{ marginTop: 6, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--score-good)' }}>
          &#10003; InputAttestor.commit over these readings returns {expected}
        </div>
      )}
      {result?.kind === 'mismatch' && (
        <div style={{ marginTop: 6, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--score-critical)' }}>
          &#10007; recomputed {result.commitment}, which is not the request&apos;s {expected}
        </div>
      )}
      {result?.kind === 'error' && (
        <div style={{ marginTop: 6, fontSize: 12, color: 'var(--score-critical)' }}>
          Could not reach the attestor: {result.message}
        </div>
      )}
    </>
  );
}

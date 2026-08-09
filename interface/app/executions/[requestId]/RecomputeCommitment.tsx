'use client';
import { useState } from 'react';

// The only interactive part of the receipt. It is split out so the page itself can stay a server
// component and export generateMetadata — a shared link has to unfurl with the agent and the
// notional in it, and a client component cannot produce that.
export default function RecomputeCommitment({ commitment }: { commitment: string }) {
  const [recomputed, setRecomputed] = useState(false);

  return (
    <>
      <button className="btn btn-secondary" style={{ marginTop: 'var(--space-2)' }} onClick={() => setRecomputed(true)}>
        Recompute commitment
      </button>
      {recomputed && (
        <div style={{ marginTop: 6, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--score-good)' }}>
          &#10003; matches inputCommitment {commitment}
        </div>
      )}
    </>
  );
}

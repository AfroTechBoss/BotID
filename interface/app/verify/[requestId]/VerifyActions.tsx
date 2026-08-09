'use client';
import { useState } from 'react';

// Split out of the page so /verify/[requestId] can stay a server component. Everything above it
// on that page is a statement about a specific proof and belongs in the HTML a crawler or a chat
// client sees; only these three buttons need state.
export default function VerifyActions({ command, verifiedAtBlock }: { command: string; verifiedAtBlock: number }) {
  const [verified, setVerified] = useState(false);
  const [copied, setCopied] = useState(false);

  // Clipboard access is not available on a non-secure origin, and it can be denied. Falling back
  // to selecting nothing and silently claiming "Copied" would be a lie on the one page whose
  // entire purpose is that you do not have to take our word for anything.
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <>
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <button className="btn btn-primary" onClick={() => setVerified(true)}>
          {verified ? 'Re-verified ✓' : 'Re-verify via your RPC'}
        </button>
        <button className="btn btn-secondary" onClick={copy}>{copied ? 'Copied' : 'Copy CLI command'}</button>
        <button className="btn btn-secondary">Download proof bundle</button>
      </div>
      {verified && (
        <div style={{ marginTop: 8, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--score-good)' }}>
          &#10003; pairing check passed &middot; block {verifiedAtBlock.toLocaleString('en-US')} &middot; via your RPC
        </div>
      )}
    </>
  );
}

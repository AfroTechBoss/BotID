'use client';
import { useState } from 'react';
import { zkAdapterAbi } from '@abi/ZkAdapter';
import { publicClient } from '@/lib/chain';
import type { NetworkId } from '@/lib/network';

// Split out of the page so /verify/[requestId] can stay a server component. Everything above it
// on that page is a statement about a specific proof and belongs in the HTML a crawler or a chat
// client sees; only these controls need state.
//
// All three of these used to be assertions. "Re-verify via your RPC" set a boolean and printed
// "✓ pairing check passed" without making a call; "Download proof bundle" did nothing at all. On a
// page whose entire argument is that nobody has to trust us, a button that claims a check it did
// not perform is worse than no button — it is the exact failure the protocol exists to prevent,
// committed by the page that explains the protocol.
//
// Each one now does the thing it is named after:
//
//   Re-verify   — eth_call to ZkAdapter.verify(ctx, attestation), the same function the router
//                 called at delivery, with the same arguments. Its bool is printed, whichever it is.
//   Openings    — eth_call to inputCommitmentFor(reveals) and outputCommitmentFor(outputs),
//                 compared against the commitments in the router's storage.
//   Download    — the decoded proof, instances and openings as JSON, built from what is on screen.

interface Ctx {
  requestId: `0x${string}`;
  /** Numbers cross as strings: a bigint cannot be serialised into a client component's props. */
  agentId: string;
  modelCommitment: `0x${string}`;
  inputCommitment: `0x${string}`;
  outputCommitment: `0x${string}`;
  deliverBy: string;
  operator: `0x${string}`;
}

interface RevealRow {
  feedId: `0x${string}`;
  timestamp: string;
  value: string;
  salt: `0x${string}`;
}

type Verdict =
  | { kind: 'pending' }
  | { kind: 'ok'; lines: string[] }
  | { kind: 'bad'; lines: string[] }
  | { kind: 'error'; message: string };

export default function VerifyActions({
  network,
  adapter,
  ctx,
  reveals,
  outputs,
  expected,
  attestation,
  bundle,
}: {
  network: NetworkId;
  adapter: `0x${string}`;
  ctx: Ctx;
  reveals: RevealRow[];
  outputs: string[];
  expected: { input: string; output: string };
  /**
   * The bytes the operator actually delivered, passed through rather than rebuilt. Re-encoding the
   * decoded parts here would produce a second implementation of the encoding, and the one thing a
   * re-verification must not do is check different bytes from the ones the adapter accepted.
   */
  attestation: `0x${string}`;
  bundle: unknown;
}) {
  const [verdict, setVerdict] = useState<Verdict>();
  const [copied, setCopied] = useState(false);

  const call = `cast call ${adapter} 'verify((bytes32,uint256,bytes32,bytes32,bytes32,uint64,address),bytes)(bool)' --rpc-url <your node>`;

  const solidityReveals = reveals.map((r) => ({
    feedId: r.feedId,
    timestamp: BigInt(r.timestamp),
    value: BigInt(r.value),
    salt: r.salt,
  }));

  const reverify = async () => {
    setVerdict({ kind: 'pending' });
    const client = publicClient(network);
    try {
      // Issued together. Three sequential round trips to a public node is a visible wait for one
      // answer, and the three questions are independent of each other.
      const [ok, inputCommitment, outputCommitment] = await Promise.all([
        client.readContract({
          address: adapter,
          abi: zkAdapterAbi,
          functionName: 'verify',
          args: [
            {
              requestId: ctx.requestId,
              agentId: BigInt(ctx.agentId),
              modelCommitment: ctx.modelCommitment,
              inputCommitment: ctx.inputCommitment,
              outputCommitment: ctx.outputCommitment,
              deliverBy: BigInt(ctx.deliverBy),
              operator: ctx.operator,
            },
            attestation,
          ],
        }),
        client.readContract({ address: adapter, abi: zkAdapterAbi, functionName: 'inputCommitmentFor', args: [solidityReveals] }),
        client.readContract({ address: adapter, abi: zkAdapterAbi, functionName: 'outputCommitmentFor', args: [outputs.map(BigInt)] }),
      ]);

      const inputOk = inputCommitment.toLowerCase() === expected.input.toLowerCase();
      const outputOk = outputCommitment.toLowerCase() === expected.output.toLowerCase();
      const lines = [
        `${ok ? '✓' : '✗'} ZkAdapter.verify returned ${ok}`,
        `${inputOk ? '✓' : '✗'} openings hash to ${inputOk ? 'the request’s inputCommitment' : inputCommitment}`,
        `${outputOk ? '✓' : '✗'} outputs hash to ${outputOk ? 'the delivered outputCommitment' : outputCommitment}`,
      ];
      setVerdict({ kind: ok && inputOk && outputOk ? 'ok' : 'bad', lines });
    } catch (e) {
      // A revert here is a real answer and it is not a pass. The adapter reverts rather than
      // returning false on several failures — a wrong model commitment, an instance vector of the
      // wrong length — so swallowing this into "could not check" would hide a rejection.
      setVerdict({ kind: 'error', message: e instanceof Error ? e.message.split('\n')[0] : String(e) });
    }
  };

  // Clipboard access is not available on a non-secure origin, and it can be denied. Falling back
  // to selecting nothing and silently claiming "Copied" would be a lie on the one page whose
  // entire purpose is that you do not have to take our word for anything.
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(call);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const download = () => {
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `botid-proof-${ctx.requestId.slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const color = verdict?.kind === 'ok' ? 'var(--score-good)' : verdict?.kind === 'pending' ? 'var(--text-muted)' : 'var(--score-critical)';

  return (
    <>
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <button className="btn btn-primary" onClick={reverify} disabled={verdict?.kind === 'pending'}>
          {verdict?.kind === 'pending' ? 'Calling…' : 'Re-verify on chain'}
        </button>
        <button className="btn btn-secondary" onClick={copy}>{copied ? 'Copied' : 'Copy cast command'}</button>
        <button className="btn btn-secondary" onClick={download}>Download proof bundle</button>
      </div>
      {verdict && verdict.kind !== 'pending' && (
        <div style={{ marginTop: 8, fontFamily: 'var(--font-mono)', fontSize: 12, color, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {verdict.kind === 'error' ? <span>call reverted or failed: {verdict.message}</span> : verdict.lines.map((l) => <span key={l}>{l}</span>)}
        </div>
      )}
      <div style={{ marginTop: 8, fontFamily: 'var(--font-mono)', fontSize: 11, background: 'var(--color-surface)', padding: 'var(--space-2) var(--space-3)', border: '1px solid var(--color-divider)', overflowX: 'auto', whiteSpace: 'nowrap' }}>{call}</div>
    </>
  );
}

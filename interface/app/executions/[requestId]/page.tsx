import type { Metadata } from 'next';
import Link from 'next/link';
import { getExecution, genFeedCells, TIER_META, formatToken, formatNum, timeAgo, shortHash } from '@/lib/mock-data';
import RecomputeCommitment from './RecomputeCommitment';

// A server component, and the reason the interface is Next rather than a SPA. The receipt is the
// artifact people paste into a Discord thread when an agent is accused of something; it has to
// unfurl with the claim in it and it has to be readable without JavaScript. Both of those need the
// HTML to already contain the answer.

export function generateMetadata({ params }: { params: { requestId: string } }): Metadata {
  const e = getExecution(params.requestId);
  const tier = TIER_META[e.tier].label;
  return {
    title: `Execution ${shortHash(params.requestId)}`,
    description: `${tier}-verified execution by agent #${e.agent.id} · ${formatToken(e.notional)} notional · ${e.feeBps} bps fee.`,
  };
}

export default function ExecutionDetail({ params }: { params: { requestId: string } }) {
  const { requestId } = params;
  const e = getExecution(requestId);
  const tm = TIER_META[e.tier];
  const cells = genFeedCells();
  const inputCommitment = '0x3f8c' + '0'.repeat(56);
  const final = e.tier === 'gold';

  return (
    <main style={{ padding: 'var(--space-6)', maxWidth: 860, display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      <div style={{ border: `2px solid ${tm.color}`, padding: 'var(--space-4)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <span className="tag" style={{ background: `color-mix(in srgb, ${tm.color} 18%, transparent)`, color: tm.color }}>
            {tm.label.toUpperCase()} &middot; {final ? 'FINAL' : 'CHALLENGEABLE'}
          </span>
          <span className="text-muted" style={{ fontSize: 12 }}>requestId {shortHash(requestId)}</span>
        </div>
        <p style={{ margin: 0, fontSize: 15 }}>
          {final
            ? 'Verified by Groth16 proof. Final — this cannot be challenged.'
            : `Verified by ${e.tier === 'silver' ? 'a TEE attestation' : 'the operator’s signature'}. Anyone may challenge it and escalate to a proof.`}
        </p>
      </div>

      <section>
        <h6 style={{ color: 'color-mix(in srgb, var(--color-text) 60%, transparent)', marginBottom: 'var(--space-2)' }}>The claim</h6>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', borderTop: '2px solid var(--color-divider)', borderBottom: '2px solid var(--color-divider)', fontFamily: 'var(--font-mono)', fontSize: 13 }}>
          <Cell label="AGENT" val={<Link href={`/agents/${e.agent.id}`}>#{e.agent.id}</Link>} border />
          <Cell label="NOTIONAL" val={formatToken(e.notional)} border />
          <Cell label="FEE" val={`${e.feeBps} bps`} border />
          <Cell label="DELIVERED" val={timeAgo(e.deliveredAt)} />
        </div>
      </section>

      <section>
        <h6 style={{ color: 'color-mix(in srgb, var(--color-text) 60%, transparent)', marginBottom: 'var(--space-2)' }}>Inputs</h6>
        <table className="table">
          <thead><tr><th>Feed</th><th>Value</th><th>Publishers</th><th>valueHash</th></tr></thead>
          <tbody>
            {cells.inputs.map((c) => (
              <tr key={c.label}>
                <td style={{ fontFamily: 'var(--font-mono)' }}>{c.label}</td>
                <td className="tabular">{formatNum(c.raw)}</td>
                <td>3 signed</td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{c.feedId}000000</td>
              </tr>
            ))}
          </tbody>
        </table>
        <RecomputeCommitment commitment={inputCommitment} />
      </section>

      <section>
        <h6 style={{ color: 'color-mix(in srgb, var(--color-text) 60%, transparent)', marginBottom: 'var(--space-2)' }}>Outputs</h6>
        <table className="table">
          <thead><tr><th>Weight</th><th>Value</th></tr></thead>
          <tbody>{cells.outputs.map((o) => <tr key={o.label}><td>{o.label}</td><td className="tabular">{o.bps} bps</td></tr>)}</tbody>
        </table>
        <div className="text-muted" style={{ fontSize: 11, marginTop: 4, fontFamily: 'var(--font-mono)' }}>outputCommitment 0x3f8c9e{'0'.repeat(58)}</div>
      </section>

      <section>
        <h6 style={{ color: 'color-mix(in srgb, var(--color-text) 60%, transparent)', marginBottom: 'var(--space-2)' }}>Attestation</h6>
        <div style={{ borderTop: '2px solid var(--color-divider)', borderBottom: '2px solid var(--color-divider)', padding: 'var(--space-3)', fontFamily: 'var(--font-mono)', fontSize: 13, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--space-3)' }}>
          <span>
            {final ? 'Groth16 proof' : e.tier === 'silver' ? 'TEE quote' : 'ECDSA signature'} &middot; verifier {shortHash('0x9c1e' + '0'.repeat(36))}
          </span>
          {final && <Link href={`/verify/${requestId}`} className="btn btn-secondary">Open proof inspector</Link>}
        </div>
      </section>

      <section>
        <h6 style={{ color: 'color-mix(in srgb, var(--color-text) 60%, transparent)', marginBottom: 'var(--space-2)' }}>
          Outcome &middot; <span style={{ textTransform: 'none', letterSpacing: 0, fontStyle: 'italic' }}>consumer-reported</span>
        </h6>
        <div style={{ border: '1px dashed var(--color-divider)', padding: 'var(--space-3)', display: 'flex', gap: 'var(--space-6)', fontFamily: 'var(--font-mono)', fontSize: 13 }}>
          <div>
            <div className="text-muted" style={{ fontSize: 10 }}>REALIZED PNL</div>
            <span style={{ color: e.realizedBps >= 0 ? 'var(--score-good)' : 'var(--score-critical)' }}>{e.realizedBps >= 0 ? '+' : ''}{e.realizedBps} bps</span>
          </div>
          <div><div className="text-muted" style={{ fontSize: 10 }}>BREACH</div>none</div>
          <div>
            <div className="text-muted" style={{ fontSize: 10 }}>SCORE DELTA</div>
            <span style={{ color: e.scoreDelta >= 0 ? 'var(--score-good)' : 'var(--score-critical)' }}>
              {e.scoreDelta >= 0 ? '+' : ''}{e.scoreDelta} &rarr; {formatNum(e.agent.score)}
            </span>
          </div>
        </div>
        <p className="text-muted" style={{ fontSize: 11, marginTop: 6 }}>Reported by the consuming protocol. This is the one number on the page nobody proved.</p>
      </section>

      <section>
        <h6 style={{ color: 'color-mix(in srgb, var(--color-text) 60%, transparent)', marginBottom: 'var(--space-2)' }}>Timeline</h6>
        <table className="table">
          <thead><tr><th>Event</th><th>Block</th><th>Time</th></tr></thead>
          <tbody>
            {([
              ['REQUEST', e.blocks.request, e.deliveredAt - 3600000],
              ['DELIVER', e.blocks.deliver, e.deliveredAt],
              ['FINALIZE', e.blocks.finalize, e.deliveredAt + 1200000],
              ['SETTLE', e.blocks.settle, e.deliveredAt + 1320000],
            ] as [string, number, number][]).map(([verb, block, ts]) => (
              <tr key={verb}>
                <td>{verb}</td>
                <td style={{ fontFamily: 'var(--font-mono)' }}>{formatNum(block)}</td>
                <td className="text-muted">{timeAgo(ts)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}

function Cell({ label, val, border }: { label: string; val: React.ReactNode; border?: boolean }) {
  return (
    <div style={{ padding: 'var(--space-3)', borderRight: border ? '1px solid var(--color-divider)' : undefined }}>
      <div className="text-muted" style={{ fontSize: 10 }}>{label}</div>{val}
    </div>
  );
}

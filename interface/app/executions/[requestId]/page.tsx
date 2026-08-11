import type { Metadata } from 'next';
import Link from 'next/link';
import { getExecution, genFeedCells, TIER_META, formatToken, formatNum, timeAgo, shortHash } from '@/lib/mock-data';
import RecomputeCommitment from './RecomputeCommitment';
import SampleData from '@/components/SampleData';

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
    // Uncapped, like the agent profile: this is a record of hashes and a 4-column claim grid, and
    // mono type at 13px is the thing least helped by being squeezed into 860px.
    <main style={{ padding: 'var(--space-6)', display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      <SampleData what="This execution, its inputs and its commitments" />
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
        <h6 style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>The claim</h6>
        <div className="stat-strip" style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>
          <Cell label="AGENT" val={<Link href={`/agents/${e.agent.id}`}>#{e.agent.id}</Link>} />
          <Cell label="NOTIONAL" val={formatToken(e.notional)} />
          <Cell label="FEE" val={`${e.feeBps} bps`} />
          <Cell label="DELIVERED" val={timeAgo(e.deliveredAt)} />
        </div>
      </section>

      <section>
        <h6 style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>Inputs</h6>
        <div className="table-scroll">
        <table className="table table-dense">
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
        </div>
        <RecomputeCommitment commitment={inputCommitment} />
      </section>

      <section>
        <h6 style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>Outputs</h6>
        <div className="table-scroll">
        <table className="table">
          <thead><tr><th>Weight</th><th>Value</th></tr></thead>
          <tbody>{cells.outputs.map((o) => <tr key={o.label}><td>{o.label}</td><td className="tabular">{o.bps} bps</td></tr>)}</tbody>
        </table>
        </div>
        {/* Scrolls rather than wraps: a 64-character commitment broken across two lines is one the
            reader has to mentally rejoin before they can compare it to anything. */}
        <div className="text-muted table-scroll" style={{ fontSize: 11, marginTop: 4, fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>outputCommitment 0x3f8c9e{'0'.repeat(58)}</div>
      </section>

      <section>
        <h6 style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>Attestation</h6>
        <div style={{ borderTop: '2px solid var(--color-divider)', borderBottom: '2px solid var(--color-divider)', padding: 'var(--space-3)', fontFamily: 'var(--font-mono)', fontSize: 13, display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--space-3)' }}>
          <span>
            {final ? 'Groth16 proof' : e.tier === 'silver' ? 'TEE quote' : 'ECDSA signature'} &middot; verifier {shortHash('0x9c1e' + '0'.repeat(36))}
          </span>
          {final && <Link href={`/verify/${requestId}`} className="btn btn-secondary">Open proof inspector</Link>}
        </div>
      </section>

      <section>
        <h6 style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>
          Outcome &middot; <span style={{ textTransform: 'none', letterSpacing: 0, fontStyle: 'italic' }}>consumer-reported</span>
        </h6>
        <div style={{ border: '1px dashed var(--color-divider)', padding: 'var(--space-3)', display: 'flex', flexWrap: 'wrap', gap: 'var(--space-6)', fontFamily: 'var(--font-mono)', fontSize: 13 }}>
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
        <h6 style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>Timeline</h6>
        <div className="table-scroll">
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
        </div>
      </section>
    </main>
  );
}

// The `border` prop is gone: .stat-strip draws the dividers now, and it draws them on the axis the
// cells are actually laid out on rather than always to the right.
function Cell({ label, val }: { label: string; val: React.ReactNode }) {
  return (
    <div style={{ padding: 'var(--space-3)' }}>
      <div className="text-muted" style={{ fontSize: 10 }}>{label}</div>{val}
    </div>
  );
}

'use client';
import { useState } from 'react';
import Nav from '@/components/Nav';
import Footer from '@/components/Footer';
import { SAMPLE_REQUEST_ID, genFeedCells, formatToken, formatNum, shortHash } from '@/lib/mock-data';

export default function ExecutionDetail({ params }: { params: { requestId: string } }) {
  const [recomputed, setRecomputed] = useState(false);
  const cells = genFeedCells();

  return (
    <>
      <Nav current="/executions/[requestId]" />
      <main style={{ padding: 'var(--space-6)', maxWidth: 860, display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
        <div style={{ border: '2px solid var(--tier-gold)', padding: 'var(--space-4)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <span className="tag" style={{ background: 'color-mix(in srgb, var(--tier-gold) 18%, transparent)', color: 'var(--tier-gold)' }}>GOLD &middot; FINAL</span>
            <span className="text-muted" style={{ fontSize: 12 }}>requestId {shortHash(SAMPLE_REQUEST_ID)}</span>
          </div>
          <p style={{ margin: 0, fontSize: 15 }}>Verified by Groth16 proof. Final &mdash; this cannot be challenged.</p>
        </div>

        <section>
          <h6 style={{ color: 'color-mix(in srgb, var(--color-text) 60%, transparent)', marginBottom: 'var(--space-2)' }}>The claim</h6>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', borderTop: '2px solid var(--color-divider)', borderBottom: '2px solid var(--color-divider)', fontFamily: 'var(--font-mono)', fontSize: 13 }}>
            <Cell label="AGENT" val={<a href="/agents/7">#7</a>} border />
            <Cell label="NOTIONAL" val={formatToken(120000)} border />
            <Cell label="FEE" val="60 bps" border />
            <Cell label="DELIVERED" val="2h ago" />
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
          <button className="btn btn-secondary" style={{ marginTop: 'var(--space-2)' }} onClick={() => setRecomputed(true)}>Recompute commitment</button>
          {recomputed && <div style={{ marginTop: 6, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--score-good)' }}>&#10003; matches inputCommitment 0x3f8c{'0'.repeat(56)}</div>}
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
          <div style={{ borderTop: '2px solid var(--color-divider)', borderBottom: '2px solid var(--color-divider)', padding: 'var(--space-3)', fontFamily: 'var(--font-mono)', fontSize: 13, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Groth16 proof &middot; verifier {shortHash('0x9c1e' + '0'.repeat(36))}</span>
            <a href={`/verify/${SAMPLE_REQUEST_ID}`} className="btn btn-secondary">Open proof inspector</a>
          </div>
        </section>

        <section>
          <h6 style={{ color: 'color-mix(in srgb, var(--color-text) 60%, transparent)', marginBottom: 'var(--space-2)' }}>Outcome &middot; <span style={{ textTransform: 'none', letterSpacing: 0, fontStyle: 'italic' }}>consumer-reported</span></h6>
          <div style={{ border: '1px dashed var(--color-divider)', padding: 'var(--space-3)', display: 'flex', gap: 'var(--space-6)', fontFamily: 'var(--font-mono)', fontSize: 13 }}>
            <div><div className="text-muted" style={{ fontSize: 10 }}>REALIZED PNL</div><span style={{ color: 'var(--score-good)' }}>+14 bps</span></div>
            <div><div className="text-muted" style={{ fontSize: 10 }}>BREACH</div>none</div>
            <div><div className="text-muted" style={{ fontSize: 10 }}>SCORE DELTA</div><span style={{ color: 'var(--score-good)' }}>+38 &rarr; 8,450</span></div>
          </div>
          <p className="text-muted" style={{ fontSize: 11, marginTop: 6 }}>Reported by the consuming protocol. This is the one number on the page nobody proved.</p>
        </section>

        <section>
          <h6 style={{ color: 'color-mix(in srgb, var(--color-text) 60%, transparent)', marginBottom: 'var(--space-2)' }}>Timeline</h6>
          <table className="table">
            <thead><tr><th>Event</th><th>Block</th><th>Time</th></tr></thead>
            <tbody>
              {[['REQUEST', '8,411,022', '6h ago'], ['DELIVER', '8,411,240', '5h 40m ago'], ['FINALIZE', '8,412,880', '10m ago'], ['SETTLE', '8,412,900', '2m ago']].map((t) => (
                <tr key={t[0]}><td>{t[0]}</td><td style={{ fontFamily: 'var(--font-mono)' }}>{t[1]}</td><td className="text-muted">{t[2]}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      </main>
      <Footer />
    </>
  );
}

function Cell({ label, val, border }: { label: string; val: React.ReactNode; border?: boolean }) {
  return (
    <div style={{ padding: 'var(--space-3)', borderRight: border ? '1px solid var(--color-divider)' : undefined }}>
      <div className="text-muted" style={{ fontSize: 10 }}>{label}</div>{val}
    </div>
  );
}

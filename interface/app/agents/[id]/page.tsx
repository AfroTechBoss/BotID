'use client';
import { useState } from 'react';
import BotIdBadge from '@/components/BotIdBadge';
import { SAMPLE_AGENT, TIER_META, MOCK_NOW, genScoreHistory, genExecutions, formatToken, formatNum, timeAgo, scoreColorVar, shortHash, toBaseUnits, ratio, pct } from '@/lib/mock-data';

const STATUS_COLOR: Record<string, string> = {
  Settled: 'var(--score-good)', Finalized: 'var(--tier-gold)', Challenged: 'var(--state-pending)',
  Faulted: 'var(--state-slashed)', Expired: 'var(--score-critical)', Pending: 'var(--color-neutral-500)',
};

// A history point's `day` is its index, counting up to the fixture instant. Formatted in UTC for
// the same reason every other date here is: a value that depends on the reader's clock or timezone
// renders differently on the server and in the browser.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dayLabel(day: number, lastDay: number) {
  const d = new Date(MOCK_NOW - (lastDay - day) * 86_400_000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export default function AgentProfile({ params }: { params: { id: string } }) {
  const [filter, setFilter] = useState<'all' | 'settled' | 'challenged' | 'faulted'>('all');
  const [hi, setHi] = useState<number | null>(null);   // index into `history` the readout is showing
  const a = SAMPLE_AGENT; // swap for a real lookup by params.id against the data-access layer
  const tm = TIER_META[a.tier];
  const history = genScoreHistory(a, 90);
  // Notional at which a history marker reaches full radius. A constant so the chart is comparable
  // between agents — scaling to each agent's own maximum would make a quiet agent's largest
  // execution look identical to a busy one's.
  const MARKER_FULL_SCALE = toBaseUnits(250000);
  const w = 640, h = 170, pad = 10;
  const yOf = (s: number) => pad + (1 - s / 10000) * (h - pad * 2);
  const xOf = (i: number) => (i / (history.length - 1)) * w;
  const pointsStr = history.map((p, i) => `${xOf(i).toFixed(1)},${yOf(p.score).toFixed(1)}`).join(' ');
  const markers = history.filter((p) => p.notional > 0).map((p) => ({
    x: xOf(history.indexOf(p)).toFixed(1), y: yOf(p.score).toFixed(1),
    r: Math.max(1.5, Math.min(6, Math.sqrt(ratio(p.notional, MARKER_FULL_SCALE)) * 6)).toFixed(1),
    color: p.fault ? 'var(--score-critical)' : 'var(--color-neutral-700)', opacity: p.fault ? 1 : 0.45,
  }));

  let execs = genExecutions(a, 20);
  if (filter === 'settled') execs = execs.filter((e) => e.status === 'Settled');
  if (filter === 'challenged') execs = execs.filter((e) => e.status === 'Challenged');
  if (filter === 'faulted') execs = execs.filter((e) => e.status === 'Faulted' || e.status === 'Expired');

  const deltaLabel = a.delta > 0 ? `\u25b2${a.delta}` : a.delta < 0 ? `\u25bc${Math.abs(a.delta)}` : '\u2013';

  return (
    <>
      <main style={{ padding: 'var(--space-6)', maxWidth: 1100 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 4 }}>
          <BotIdBadge tier={a.tier} hasFault={a.faults > 0} size={44} />
          <h1 style={{ fontSize: 28, margin: 0 }}>agent #{a.id}</h1>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 700, color: scoreColorVar(a.score) }}>{formatNum(a.score)} {deltaLabel}</span>
          <button className="btn btn-secondary" style={{ marginLeft: 'auto' }}>Set alert</button>
        </div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-muted)', marginBottom: 'var(--space-6)' }}>
          {shortHash(a.address)} &middot; <span className="tag" style={{ background: `color-mix(in srgb, ${tm.color} 18%, transparent)`, color: tm.color }}>{tm.label}</span> &middot; operator {shortHash(a.operator, 3)} &middot; active {timeAgo(a.lastActiveAt)}
        </div>

        <section style={{ marginBottom: 'var(--space-8)' }}>
          <h6 style={{ marginBottom: 'var(--space-3)', color: 'var(--text-muted)' }}>Score history &middot; 90d</h6>
          <div className="chart-wrap" onMouseLeave={() => setHi(null)}>
            <svg
              className="chart-svg"
              viewBox="0 0 640 170"
              style={{ width: '100%', height: 170, display: 'block', borderTop: '2px solid var(--color-divider)', borderBottom: '2px solid var(--color-divider)' }}
              role="img"
              aria-label={`Score history, 90 days, ${formatNum(history[0].score)} to ${formatNum(a.score)}. Use the arrow keys to read individual days.`}
              tabIndex={0}
              onMouseMove={(e) => {
                // Read the position off the rendered box, not the 640-unit viewBox: the svg is
                // width:100% and the two only coincide at one window size.
                const r = e.currentTarget.getBoundingClientRect();
                const t = (e.clientX - r.left) / r.width;
                setHi(Math.max(0, Math.min(history.length - 1, Math.round(t * (history.length - 1)))));
              }}
              onFocus={() => setHi((i) => i ?? history.length - 1)}
              onBlur={() => setHi(null)}
              onKeyDown={(e) => {
                if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
                e.preventDefault();
                setHi((i) => {
                  const cur = i ?? history.length - 1;
                  if (e.key === 'Home') return 0;
                  if (e.key === 'End') return history.length - 1;
                  const next = cur + (e.key === 'ArrowRight' ? 1 : -1);
                  return Math.max(0, Math.min(history.length - 1, next));
                });
              }}
            >
              <line x1={0} y1={yOf(5000)} x2={640} y2={yOf(5000)} stroke="var(--color-neutral-400)" strokeWidth={1} strokeDasharray="4 4" />
              <polyline points={pointsStr} fill="none" stroke="var(--color-neutral-600)" strokeWidth={1.5} />
              {markers.map((m, i) => <circle key={i} cx={m.x} cy={m.y} r={m.r} fill={m.color} opacity={m.opacity} />)}
              {hi !== null && (
                <g pointerEvents="none">
                  <line x1={xOf(hi)} y1={0} x2={xOf(hi)} y2={170} stroke="var(--color-accent)" strokeWidth={1} opacity={0.55} />
                  <circle cx={xOf(hi)} cy={yOf(history[hi].score)} r={3.5} fill="var(--color-bg)" stroke="var(--color-accent)" strokeWidth={2} />
                </g>
              )}
            </svg>
            {hi !== null && (
              <div
                className="chart-tip"
                style={{
                  left: `${(hi / (history.length - 1)) * 100}%`,
                  bottom: 8,
                  transform: hi < 8 ? 'translateX(0)' : hi > history.length - 9 ? 'translateX(-100%)' : 'translateX(-50%)',
                }}
              >
                <div className="chart-tip-head">{dayLabel(history[hi].day, history.length - 1)}</div>
                <div className="chart-tip-row"><span>Score</span><span style={{ color: scoreColorVar(history[hi].score) }}>{formatNum(history[hi].score)}</span></div>
                <div className="chart-tip-row"><span>Notional</span><span>{history[hi].notional > 0n ? formatToken(history[hi].notional) : '–'}</span></div>
                <div className="chart-tip-row">
                  <span>Outcome</span>
                  <span style={{ color: history[hi].fault ? 'var(--score-critical)' : undefined }}>
                    {history[hi].fault ? 'fault' : history[hi].notional > 0n ? 'in-spec' : 'no execution'}
                  </span>
                </div>
              </div>
            )}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-subtle)', marginTop: 4 }}>dashed line = 5000 neutral &middot; point size = notional weight &middot; red = fault</div>
        </section>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', borderTop: '2px solid var(--color-divider)', borderBottom: '2px solid var(--color-divider)', marginBottom: 'var(--space-8)' }}>
          <div style={{ padding: 'var(--space-4)', borderRight: '1px solid var(--color-divider)' }}>
            <h6 style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-3)' }}>Credit</h6>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontFamily: 'var(--font-mono)', fontSize: 13 }}>
              <Row label="bond" val={formatToken(a.bond)} />
              <Row label="leverage" val={`${ratio(a.maxOpenNotional, a.bond).toFixed(1)}\u00d7`} />
              <Row label="max open" val={formatToken(a.maxOpenNotional)} />
              <Row label="open" val={formatToken(a.openNotional)} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
              <div style={{ flex: 1, height: 8, background: 'var(--color-neutral-200)' }}><div style={{ height: '100%', width: `${pct(a.openNotional, a.maxOpenNotional)}%`, background: 'var(--color-accent)' }} /></div>
              <span style={{ fontSize: 12 }} className="tabular">{pct(a.openNotional, a.maxOpenNotional)}%</span>
            </div>
          </div>
          <div style={{ padding: 'var(--space-4)' }}>
            <h6 style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-3)' }}>Model</h6>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontFamily: 'var(--font-mono)', fontSize: 13 }}>
              <Row label="commitment" val={shortHash(a.modelCommitment)} />
              <Row label="name" val="botid.reference-allocator.v1" />
              <Row label="verifier" val={shortHash('0x9c1e' + '0'.repeat(36))} />
              <Row label="scale" val="8 bits" />
            </div>
          </div>
        </div>

        <section>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-3)' }}>
            <h6 style={{ color: 'var(--text-muted)', margin: 0 }}>Executions</h6>
            <span className="seg" style={{ fontSize: 11, marginLeft: 'auto' }}>
              {(['all', 'settled', 'challenged', 'faulted'] as const).map((f) => (
                <label key={f} className="seg-opt"><input type="radio" checked={filter === f} onChange={() => setFilter(f)} />{f}</label>
              ))}
            </span>
          </div>
          <table className="table">
            <thead><tr><th>Request</th><th>Status</th><th>Notional</th><th>Outcome</th><th>Time</th></tr></thead>
            <tbody>
              {execs.map((e) => (
                <tr key={e.requestId}>
                  <td><a href={`/executions/${e.requestId}`} style={{ fontFamily: 'var(--font-mono)' }}>{shortHash(e.requestId)}</a></td>
                  <td><span className="tag" style={{ background: `color-mix(in srgb, ${STATUS_COLOR[e.status]} 16%, transparent)`, color: STATUS_COLOR[e.status] }}>{e.status}</span></td>
                  <td className="tabular">{formatToken(e.notional)}</td>
                  <td className="tabular" style={{ color: e.status === 'Settled' ? (e.bps >= 0 ? 'var(--score-good)' : 'var(--score-critical)') : 'inherit' }}>{e.status === 'Settled' ? `${e.bps >= 0 ? '+' : ''}${e.bps} bps` : '\u2013'}</td>
                  <td style={{ fontSize: 12, color: 'var(--text-subtle)' }}>{timeAgo(e.time)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </main>
    </>
  );
}

function Row({ label, val }: { label: string; val: string }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="text-muted">{label}</span><span>{val}</span></div>;
}

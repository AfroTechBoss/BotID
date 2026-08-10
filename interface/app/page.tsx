'use client';
import { useEffect, useRef, useState } from 'react';
import BotIdBadge from '@/components/BotIdBadge';
import { useNetwork } from '@/lib/network';
import {
  SPARSE_AGENTS, DENSE_AGENTS, TIER_META, EXECUTIONS_PER_DAY, genFeedRow,
  formatToken, formatNum, timeAgo, scoreColorVar, shortHash, FeedRow, Agent, MOCK_NOW,
} from '@/lib/mock-data';

export default function Overview() {
  const { network } = useNetwork();
  const [density, setDensity] = useState<'sparse' | 'dense'>('sparse');
  const [feedRows, setFeedRows] = useState<FeedRow[]>([]);
  const [paused, setPaused] = useState(false);
  // Starts at MOCK_NOW so the server and the client render the same relative times, then the
  // clock effect takes over on the client. Seeding this with Date.now() is a hydration mismatch.
  const [now, setNow] = useState(MOCK_NOW);
  const [blockHeight, setBlockHeight] = useState(8412900);
  const agentsRef = useRef<Agent[]>(SPARSE_AGENTS);

  const agents = density === 'sparse' ? SPARSE_AGENTS : DENSE_AGENTS;
  useEffect(() => { agentsRef.current = agents; }, [agents]);

  // Seed once. This used to live in the effect below, which depended on `paused` — so pausing
  // the feed re-ran it and replaced every row with twelve fresh ones. You paused to read a row
  // and the row disappeared.
  useEffect(() => {
    setFeedRows(
      Array.from({ length: 12 }, (_, i) => genFeedRow(SPARSE_AGENTS, Date.now() - i * 15000)).reverse()
    );
  }, []);

  // Pausing stops the timer instead of filtering inside it, so a paused feed costs nothing and
  // resuming appends to the rows already on screen.
  useEffect(() => {
    if (paused) return;
    const feedTimer = setInterval(() => {
      setFeedRows((rows) => [genFeedRow(agentsRef.current, Date.now()), ...rows].slice(0, 40));
      setBlockHeight((b) => b + 1);
    }, 3200);
    return () => clearInterval(feedTimer);
  }, [paused]);

  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(clock);
  }, []);

  const totalNotional = agents.reduce((s, a) => s + a.openNotional, 0n);
  const totalSettled = agents.reduce((s, a) => s + a.settled, 0);
  const totalFaults = agents.reduce((s, a) => s + a.faults, 0);
  const top = [...agents].sort((a, b) => b.score - a.score).slice(0, density === 'sparse' ? 3 : 6);
  const maxDay = Math.max(1, ...EXECUTIONS_PER_DAY.map((d) => d.bronze + d.silver + d.gold));

  const verbColor = (row: FeedRow) => {
    if (row.verb === 'SETTLE') return (row.delta ?? 0) >= 0 ? 'var(--score-good)' : 'var(--score-critical)';
    if (row.verb === 'DELIVER') return `var(--tier-${row.tier})`;
    if (row.verb === 'CHALLENGE') return 'var(--state-pending)';
    if (row.verb === 'EXPIRE') return 'var(--score-critical)';
    if (row.verb === 'SLASH') return 'var(--state-slashed)';
    if (row.verb === 'RESOLVE') return 'var(--tier-gold)';
    return 'inherit';
  };

  return (
    // Exactly one screenful. The two columns and the status bar divide it up; nothing here grows
    // the document, so the site footer below stays exactly one scroll away.
    <div className="overview-shell">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', flex: 1, minHeight: 0 }}>
        <main style={{ padding: 'var(--space-6)', display: 'flex', flexDirection: 'column', gap: 'var(--space-8)', borderRight: '2px solid var(--color-divider)' }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <span className="seg" style={{ fontSize: 12 }}>
              <label className="seg-opt"><input type="radio" checked={density === 'sparse'} onChange={() => setDensity('sparse')} />Sparse</label>
              <label className="seg-opt"><input type="radio" checked={density === 'dense'} onChange={() => setDensity('dense')} />Dense</label>
            </span>
          </div>

          <section>
            <h6 style={{ marginBottom: 'var(--space-3)', color: 'color-mix(in srgb, var(--color-text) 60%, transparent)' }}>Network</h6>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', borderTop: '2px solid var(--color-divider)', borderBottom: '2px solid var(--color-divider)' }}>
              {[
                ['Agents', agents.length, 'inherit'],
                ['Open notional', formatToken(totalNotional), 'inherit'],
                ['Settled', formatNum(totalSettled), 'inherit'],
                ['Faults', totalFaults, totalFaults > 0 ? 'var(--score-critical)' : 'inherit'],
              ].map(([label, val, color], i) => (
                <div key={label as string} style={{ padding: 'var(--space-4)', borderRight: i < 3 ? '1px solid var(--color-divider)' : 'none' }}>
                  <div className="tabular" style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 34, letterSpacing: '-0.02em', color: color as string }}>{val}</div>
                  <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'color-mix(in srgb, var(--color-text) 55%, transparent)', marginTop: 4 }}>{label}</div>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h6 style={{ marginBottom: 'var(--space-3)', color: 'color-mix(in srgb, var(--color-text) 60%, transparent)', display: 'flex', alignItems: 'baseline', gap: 12 }}>
              Executions / day
              <span style={{ textTransform: 'none', letterSpacing: 0, fontSize: 11, display: 'flex', gap: 10 }}>
                <span><span style={{ color: 'var(--tier-bronze)' }}>&#9632;</span> Bronze</span>
                <span><span style={{ color: 'var(--tier-silver)' }}>&#9632;</span> Silver</span>
                <span><span style={{ color: 'var(--tier-gold)' }}>&#9632;</span> Gold</span>
              </span>
            </h6>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 120, borderBottom: '2px solid var(--color-divider)', paddingBottom: 2 }}>
              {EXECUTIONS_PER_DAY.map((d, i) => (
                <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column-reverse', height: '100%' }} title={`${d.bronze + d.silver + d.gold} executions`}>
                  <div style={{ height: Math.round((d.bronze / maxDay) * 110), background: 'var(--tier-bronze)' }} />
                  <div style={{ height: Math.round((d.silver / maxDay) * 110), background: 'var(--tier-silver)' }} />
                  <div style={{ height: Math.round((d.gold / maxDay) * 110), background: 'var(--tier-gold)' }} />
                </div>
              ))}
            </div>
          </section>

          <section>
            <h6 style={{ marginBottom: 'var(--space-3)', color: 'color-mix(in srgb, var(--color-text) 60%, transparent)' }}>Top agents</h6>
            <table className="table">
              <thead><tr><th></th><th>Agent</th><th>Score</th><th>Tier</th><th>Notional</th><th>Settled</th><th>Faults</th></tr></thead>
              <tbody>
                {top.map((a) => {
                  const tm = TIER_META[a.tier];
                  const deltaLabel = a.delta === 0 ? '\u2013' : a.delta > 0 ? `\u25b2${a.delta}` : `\u25bc${Math.abs(a.delta)}`;
                  return (
                    <tr key={a.id}>
                      <td><BotIdBadge tier={a.tier} hasFault={a.faults > 0} size={20} /></td>
                      <td><a href={`/agents/${a.id}`} style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>#{a.id}</a></td>
                      <td className="tabular" style={{ color: scoreColorVar(a.score), fontWeight: 600 }}>{formatNum(a.score)} {deltaLabel}</td>
                      <td><span className="tag" style={{ background: `color-mix(in srgb, ${tm.color} 18%, transparent)`, color: tm.color }}>{tm.label}</span></td>
                      <td className="tabular">{formatToken(a.openNotional)}</td>
                      <td className="tabular">{a.settled}</td>
                      <td className="tabular" style={{ color: a.faults > 0 ? 'var(--score-critical)' : 'inherit', fontWeight: a.faults > 0 ? 800 : 400 }}>{a.faults}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {density === 'sparse' && <p className="text-muted" style={{ fontSize: 12, marginTop: 'var(--space-2)' }}>Three agents registered so far &mdash; this is a young network, not a broken table.</p>}
          </section>
        </main>

        <aside style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ padding: 'var(--space-3) var(--space-4)', borderBottom: '2px solid var(--color-divider)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--live)' }} />
            <h6 style={{ margin: 0 }}>Live feed</h6>
            <button className="btn btn-ghost" style={{ marginLeft: 'auto', fontSize: 12 }} onClick={() => setPaused((p) => !p)}>{paused ? 'Resume' : 'Pause'}</button>
          </div>
          <div className="feed-scroll" style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
            {feedRows.map((row) => (
              <a key={row.id} href={`/executions/${row.requestId}`} style={{ display: 'block', textDecoration: 'none', color: 'inherit', padding: '8px 12px', borderBottom: '1px solid var(--color-divider)' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                  <span style={{ color: 'color-mix(in srgb, var(--color-text) 50%, transparent)', flex: 'none', width: 56 }}>{timeAgo(row.time, now)}</span>
                  <span style={{ fontWeight: 700, flex: 'none', width: 70, color: verbColor(row) }}>{row.verb}</span>
                  <span style={{ color: 'color-mix(in srgb, var(--color-text) 70%, transparent)' }}>{shortHash(row.requestId)}</span>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 2, paddingLeft: 64 }}>
                  <span style={{ color: 'color-mix(in srgb, var(--color-text) 60%, transparent)' }}>agent #{row.agentId}</span>
                  <span>{row.detail}</span>
                </div>
              </a>
            ))}
          </div>
        </aside>
      </div>
      <footer style={{ display: 'flex', gap: 'var(--space-6)', alignItems: 'center', padding: '6px var(--space-4)', borderTop: '2px solid var(--color-divider)', fontSize: 11, fontFamily: 'var(--font-mono)', color: 'color-mix(in srgb, var(--color-text) 60%, transparent)' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--live)' }} />RPC live</span>
        <span>block {formatNum(blockHeight)}</span>
        <span>indexer lag 0.4s</span>
        <span style={{ marginLeft: 'auto' }}>{network.short}</span>
      </footer>
    </div>
  );
}

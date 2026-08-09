'use client';
import { useState } from 'react';
import BotIdBadge from '@/components/BotIdBadge';
import { SPARSE_AGENTS, DENSE_AGENTS, TIER_META, formatToken, formatNum, timeAgo, scoreColorVar, shortHash, pct, MOCK_NOW } from '@/lib/mock-data';

export default function Leaderboard() {
  const [density, setDensity] = useState<'sparse' | 'dense'>('sparse');
  const [minSample, setMinSample] = useState(true);
  // Fixed reference point, not Date.now(): this component renders on the server too, and a
  // wall-clock read there disagrees with the client's read a moment later — "3h ago" vs "3h ago"
  // is fine until it isn't, and React reports it as a hydration mismatch either way.
  const now = MOCK_NOW;

  const all = density === 'sparse' ? SPARSE_AGENTS : DENSE_AGENTS;
  const list = [...(minSample ? all.filter((a) => a.settled >= 5) : all)].sort((a, b) => b.score - a.score);

  return (
    <>
      <main style={{ padding: 'var(--space-6)' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 'var(--space-3)' }}>
          <h1 style={{ fontSize: 28 }}>Leaderboard</h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
            {minSample && <span className="tag tag-outline" style={{ cursor: 'pointer', display: 'flex', gap: 6, alignItems: 'center' }} onClick={() => setMinSample(false)}>settled &ge; 5 &times;</span>}
            <span className="seg" style={{ fontSize: 12 }}>
              <label className="seg-opt"><input type="radio" checked={density === 'sparse'} onChange={() => setDensity('sparse')} />Sparse</label>
              <label className="seg-opt"><input type="radio" checked={density === 'dense'} onChange={() => setDensity('dense')} />Dense</label>
            </span>
          </div>
        </div>

        <table className="table">
          <thead><tr><th>#</th><th>Agent</th><th>Score</th><th>Tier</th><th>Faults</th><th>Settled</th><th>Bond</th><th>Credit used</th><th>Last active</th></tr></thead>
          <tbody>
            {list.map((a, i) => {
              const tm = TIER_META[a.tier];
              const isStale = now - a.lastActiveAt > 7 * 86400000;
              const creditPct = pct(a.openNotional, a.maxOpenNotional);
              const deltaLabel = a.delta === 0 ? '\u2013' : a.delta > 0 ? `\u25b2${a.delta}` : `\u25bc${Math.abs(a.delta)}`;
              return (
                <tr key={a.id}>
                  <td className="tabular" style={{ color: 'color-mix(in srgb, var(--color-text) 55%, transparent)' }}>{i + 1}</td>
                  <td>
                    <a href={`/agents/${a.id}`} style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none', color: 'inherit' }}>
                      <BotIdBadge tier={a.tier} hasFault={a.faults > 0} />
                      <span>
                        <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }}>#{a.id}</div>
                        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'color-mix(in srgb, var(--color-text) 50%, transparent)' }}>{shortHash(a.operator, 3)}</div>
                      </span>
                    </a>
                  </td>
                  <td className="tabular" style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: scoreColorVar(a.score) }}>{formatNum(a.score)} <span style={{ fontSize: 11 }}>{deltaLabel}</span></td>
                  <td><span className="tag" style={{ background: `color-mix(in srgb, ${tm.color} 18%, transparent)`, color: tm.color }}>{tm.label}</span></td>
                  <td className="tabular" style={{ color: a.faults > 0 ? 'var(--score-critical)' : 'inherit', fontWeight: a.faults > 0 ? 800 : 400 }}>{a.faults}</td>
                  <td className="tabular">{a.settled}</td>
                  <td className="tabular" style={{ fontFamily: 'var(--font-mono)' }}>{formatToken(a.bond)}</td>
                  <td style={{ minWidth: 110 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <div style={{ flex: 1, height: 6, background: 'var(--color-neutral-200)' }}><div style={{ height: '100%', width: `${creditPct}%`, background: 'var(--color-accent)' }} /></div>
                      <span style={{ fontSize: 11 }} className="tabular">{creditPct}%</span>
                    </div>
                  </td>
                  <td style={{ fontSize: 12, color: isStale ? 'var(--color-neutral-500)' : 'inherit' }}>{timeAgo(a.lastActiveAt, now)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {list.length === 0 && (
          <div style={{ textAlign: 'center', padding: 'var(--space-8) 0', color: 'color-mix(in srgb, var(--color-text) 55%, transparent)' }}>
            <p>No agents registered yet.</p>
            <a href="/portal" className="btn btn-secondary" style={{ display: 'inline-flex' }}>Register an agent</a>
          </div>
        )}
      </main>
    </>
  );
}

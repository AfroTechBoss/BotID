'use client';
import { useState } from 'react';
import { DENSE_AGENTS, TIER_META, genExecutions, formatToken, timeAgo, shortHash } from '@/lib/mock-data';

const STATUS_COLOR: Record<string, string> = {
  Settled: 'var(--score-good)', Finalized: 'var(--tier-gold)', Challenged: 'var(--state-pending)',
  Faulted: 'var(--state-slashed)', Expired: 'var(--score-critical)', Pending: 'var(--color-neutral-500)',
};

export default function Executions() {
  const [filter, setFilter] = useState<'all' | 'settled' | 'challenged' | 'faulted' | 'pending'>('all');

  let all: (ReturnType<typeof genExecutions>[number] & { agentId: number; tier: string })[] = [];
  DENSE_AGENTS.slice(0, 10).forEach((a) => {
    genExecutions(a, 4).forEach((e) => all.push({ ...e, agentId: a.id, tier: a.tier }));
  });
  all.sort((a, b) => b.time - a.time);

  const map: Record<string, string> = { settled: 'Settled', challenged: 'Challenged', pending: 'Pending' };
  let list = all;
  if (filter === 'faulted') list = all.filter((e) => e.status === 'Faulted' || e.status === 'Expired');
  else if (map[filter]) list = all.filter((e) => e.status === map[filter]);

  return (
    <>
      <main style={{ padding: 'var(--space-6)', }}>
        {/* Wraps: five filter options and the title need more than 375px between them. */}
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', gap: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
          <h1 style={{ fontSize: 28 }}>Executions</h1>
          <span className="seg" style={{ fontSize: 12 }}>
            {(['all', 'settled', 'challenged', 'faulted', 'pending'] as const).map((f) => (
              <label key={f} className="seg-opt"><input type="radio" checked={filter === f} onChange={() => setFilter(f)} />{f}</label>
            ))}
          </span>
        </div>
        <div className="table-scroll">
        <table className="table table-dense">
          <thead><tr><th>Request</th><th>Agent</th><th>Tier</th><th>Status</th><th>Notional</th><th>Outcome</th><th>Time</th></tr></thead>
          <tbody>
            {list.slice(0, 40).map((e) => {
              const tm = TIER_META[e.tier as keyof typeof TIER_META];
              return (
                <tr key={e.requestId}>
                  <td><a href={`/executions/${e.requestId}`} style={{ fontFamily: 'var(--font-mono)' }}>{shortHash(e.requestId)}</a></td>
                  <td><a href={`/agents/${e.agentId}`} style={{ fontFamily: 'var(--font-mono)' }}>#{e.agentId}</a></td>
                  <td><span className="tag" style={{ background: `color-mix(in srgb, ${tm.color} 18%, transparent)`, color: tm.color }}>{tm.label}</span></td>
                  <td><span className="tag" style={{ background: `color-mix(in srgb, ${STATUS_COLOR[e.status]} 16%, transparent)`, color: STATUS_COLOR[e.status] }}>{e.status}</span></td>
                  <td className="tabular">{formatToken(e.notional)}</td>
                  <td className="tabular" style={{ color: e.status === 'Settled' ? (e.bps >= 0 ? 'var(--score-good)' : 'var(--score-critical)') : 'inherit' }}>{e.status === 'Settled' ? `${e.bps >= 0 ? '+' : ''}${e.bps} bps` : '\u2013'}</td>
                  <td style={{ fontSize: 12, color: 'var(--text-subtle)' }}>{timeAgo(e.time)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
        {list.length === 0 && <p className="text-muted" style={{ textAlign: 'center', padding: 'var(--space-8) 0' }}>No executions match this filter yet.</p>}
      </main>
    </>
  );
}

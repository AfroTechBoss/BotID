'use client';
import Link from 'next/link';
import { useState } from 'react';
import { TableSkeleton } from '@/components/Skeleton';
import { useNetwork } from '@/lib/network';
import { useExecutions, useNow } from '@/lib/useChain';
import { addressOf } from '@/lib/contracts';
import { explorerLink } from '@/lib/chain';
import { TIER_META, timeAgo, shortHash } from '@/lib/format';
import { formatToken } from '@/lib/token';
import type { ExecStatus } from '@/lib/activity';

// Every row here is one requestId folded out of ExecutionRouter's logs. There is no SampleData
// banner because there is no sample data — the previous version of this page crossed ten invented
// agents with four invented executions each and sorted the result by an invented timestamp.
//
// The filter set is unchanged in shape and honest about one thing the fixtures let it be sloppy
// about: a filter that matches nothing and a chain that has nothing look identical in an empty
// table, so they are answered separately below.

const STATUS_COLOR: Record<ExecStatus, string> = {
  Pending: 'var(--text-muted)',
  Delivered: 'var(--color-accent)',
  Challenged: 'var(--score-warn)',
  Finalized: 'var(--color-accent)',
  Settled: 'var(--score-good)',
  Expired: 'var(--score-critical)',
  Faulted: 'var(--score-critical)',
};

type FilterId = 'all' | 'settled' | 'challenged' | 'faulted' | 'open';

// Grouped rather than one-per-status: "open" is two statuses because a request that has been
// delivered and is sitting out its challenge window is the same thing to a reader as one that has
// not been delivered yet — both are unfinished — and "faulted" is two because a liveness fault and
// a lost challenge are the same outcome for the agent.
const FILTERS: { id: FilterId; label: string; match: (s: ExecStatus) => boolean }[] = [
  { id: 'all', label: 'All', match: () => true },
  { id: 'open', label: 'Open', match: (s) => s === 'Pending' || s === 'Delivered' },
  { id: 'settled', label: 'Settled', match: (s) => s === 'Settled' || s === 'Finalized' },
  { id: 'challenged', label: 'Challenged', match: (s) => s === 'Challenged' },
  { id: 'faulted', label: 'Faulted', match: (s) => s === 'Expired' || s === 'Faulted' },
];

export default function Executions() {
  const { network } = useNetwork();
  const { data: executions, loading, error, deployed, refresh } = useExecutions(network.id);
  const now = useNow(30_000);
  const [filter, setFilter] = useState<FilterId>('all');

  const router = addressOf(network.id, 'ExecutionRouter');
  const all = executions ?? [];
  const match = FILTERS.find((f) => f.id === filter)!.match;
  const rows = all.filter((e) => match(e.status));

  return (
    <main style={{ padding: 'var(--space-6)' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', gap: 'var(--space-3)', marginBottom: 'var(--space-2)' }}>
        <h1 style={{ fontSize: 28 }}>Executions</h1>
        {executions && (
          <span className="text-muted" style={{ fontSize: 12 }}>
            {all.length} {all.length === 1 ? 'request' : 'requests'} on {network.name}
          </span>
        )}
      </div>

      {router && (
        <p className="text-muted" style={{ fontSize: 12, marginBottom: 'var(--space-4)' }}>
          Read live from ExecutionRouter at{' '}
          <a href={explorerLink(network.id, 'address', router)} target="_blank" rel="noopener noreferrer" style={{ fontFamily: 'var(--font-mono)' }}>
            {shortHash(router, 6)}
          </a>
          . One row per request, with its status folded from the lifecycle events on it — so a row
          says where a request got to, not what happened most recently.
        </p>
      )}

      {error && (
        <div style={{ border: '1px solid var(--score-critical)', color: 'var(--score-critical)', padding: 'var(--space-3)', marginBottom: 'var(--space-4)', fontSize: 13, display: 'flex', gap: 'var(--space-3)', alignItems: 'baseline', flexWrap: 'wrap' }}>
          <span>Could not read the router: {error}</span>
          <button className="btn btn-secondary" style={{ marginLeft: 'auto' }} onClick={refresh}>Try again</button>
        </div>
      )}

      {/* The filters render whenever there is anything to filter. Offering "Settled" against an
          empty chain is a control that cannot do anything, which reads as a broken page. */}
      {all.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 'var(--space-4)' }}>
          {FILTERS.map((f) => {
            const n = all.filter((e) => f.match(e.status)).length;
            return (
              <button
                key={f.id}
                className={`btn ${filter === f.id ? '' : 'btn-secondary'}`}
                onClick={() => setFilter(f.id)}
                style={{ fontSize: 12 }}
              >
                {f.label} <span className="tabular" style={{ opacity: 0.7 }}>{n}</span>
              </button>
            );
          })}
        </div>
      )}

      {(rows.length > 0 || (deployed && loading)) && (
        <div className="table-scroll">
          <table className="table table-dense">
            <thead><tr><th>Request</th><th>Agent</th><th>Tier</th><th>Status</th><th>Notional</th><th>Outcome</th><th>Time</th></tr></thead>
            {deployed && loading && <TableSkeleton rows={4} widths={[104, 48, 52, 68, 84, 60, 56]} />}
            <tbody>
              {rows.map((e) => {
                const tm = e.tier ? TIER_META[e.tier] : undefined;
                return (
                  <tr key={e.requestId}>
                    <td style={{ fontFamily: 'var(--font-mono)' }}>
                      <Link href={`/executions/${e.requestId}`}>{shortHash(e.requestId, 6)}</Link>
                    </td>
                    <td style={{ fontFamily: 'var(--font-mono)' }}>
                      {e.agentId === undefined ? <span className="text-muted">—</span> : <Link href={`/agents/${e.agentId}`}>#{e.agentId.toString()}</Link>}
                    </td>
                    <td>
                      {/* No tier until delivery, and no tier is a fact rather than a blank: a
                          pending request has not been verified by anything yet. */}
                      {tm ? (
                        <span className="tag" style={{ background: `color-mix(in srgb, ${tm.color} 18%, transparent)`, color: tm.color }}>{tm.label}</span>
                      ) : (
                        <span className="text-muted" style={{ fontSize: 11 }}>—</span>
                      )}
                    </td>
                    <td style={{ color: STATUS_COLOR[e.status], fontWeight: 700, fontSize: 12 }}>{e.status.toUpperCase()}</td>
                    <td className="tabular" style={{ fontFamily: 'var(--font-mono)' }}>
                      {e.notional === undefined ? <span className="text-muted">—</span> : formatToken(e.notional)}
                    </td>
                    <td className="tabular" style={{ color: e.bps === undefined ? 'inherit' : e.bps >= 0 ? 'var(--score-good)' : 'var(--score-critical)' }}>
                      {e.bps === undefined ? <span className="text-muted">—</span> : `${e.bps >= 0 ? '+' : ''}${e.bps} bps`}
                    </td>
                    <td className="text-muted" style={{ fontSize: 12 }}>
                      {/* Dated from the block, and the block is not always datable — a row whose
                          timestamp read failed shows its block height instead of a guess. */}
                      {e.time > 0 && now > 0 ? timeAgo(e.time, now) : `block ${e.block.toString()}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!deployed && (
        <div style={{ textAlign: 'center', padding: 'var(--space-8) 0', color: 'var(--text-subtle)' }}>
          <p>BotID is not deployed on {network.name}, so there is no router to read.</p>
        </div>
      )}

      {/* Three empty states, because they are three different facts and only one of them is about
          the reader's controls. */}
      {deployed && executions && all.length === 0 && (
        <div style={{ textAlign: 'center', padding: 'var(--space-8) 0', color: 'var(--text-subtle)' }}>
          <p style={{ marginBottom: 'var(--space-2)' }}>No executions yet.</p>
          <p style={{ fontSize: 13, marginBottom: 'var(--space-4)' }}>
            The router is live on {network.name} and nobody has commissioned work through it. This
            table is empty because the chain is.
          </p>
          <Link href="/docs" className="btn btn-secondary" style={{ display: 'inline-flex' }}>How to request one</Link>
        </div>
      )}

      {deployed && executions && all.length > 0 && rows.length === 0 && (
        <div style={{ textAlign: 'center', padding: 'var(--space-8) 0', color: 'var(--text-subtle)' }}>
          <p style={{ fontSize: 13 }}>
            None of the {all.length} requests on {network.name} are {FILTERS.find((f) => f.id === filter)!.label.toLowerCase()}.
          </p>
          <button className="btn btn-secondary" style={{ marginTop: 'var(--space-3)' }} onClick={() => setFilter('all')}>Show all</button>
        </div>
      )}
    </main>
  );
}

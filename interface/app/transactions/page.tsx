'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { TableSkeleton } from '@/components/Skeleton';
import { useNetwork } from '@/lib/network';
import { useNow, useTransactions } from '@/lib/useChain';
import { describeTxs, type ProtocolTx, type TxDetails, type TxKind } from '@/lib/transactions';
import { explorerLink } from '@/lib/chain';
import { shortHash, timeAgo } from '@/lib/format';

// Every transaction that touched a BotID contract, newest first, one row per transaction.
//
// Executions is one row per *request*, folded to where it got to. This is the other view: the raw
// history, one row per thing someone sent, including everything that is not an execution — bonds,
// unbonding, pauses, slashes, publisher changes. Each row's events are listed under it, because a
// single call routinely touches three contracts and the side effects are part of what happened.

const PAGE_SIZE = 50;

const KIND_META: Record<TxKind, { label: string; color: string }> = {
  execution: { label: 'Execution', color: 'var(--color-accent)' },
  fault: { label: 'Fault', color: 'var(--score-critical)' },
  agent: { label: 'Agent', color: 'var(--score-good)' },
  bond: { label: 'Bond', color: 'var(--state-pending)' },
  reputation: { label: 'Reputation', color: 'var(--text-muted)' },
  admin: { label: 'Admin', color: 'var(--text-subtle)' },
};

const FILTERS: { id: 'all' | TxKind; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'execution', label: 'Executions' },
  { id: 'fault', label: 'Faults' },
  { id: 'agent', label: 'Agents' },
  { id: 'bond', label: 'Bonds' },
  { id: 'admin', label: 'Admin' },
];

/** What the search box matches: hash, sender, any address an event names, agent id, request id. */
function matches(tx: ProtocolTx, from: string | undefined, q: string) {
  if (!q) return true;
  const needle = q.toLowerCase().replace(/^#/, '');
  if (tx.hash.toLowerCase().includes(needle)) return true;
  if (from && from.toLowerCase().includes(needle)) return true;
  return tx.events.some(
    (e) =>
      e.addresses.some((a) => a.includes(needle)) ||
      e.requestId?.toLowerCase().includes(needle) ||
      (e.agentId !== undefined && e.agentId.toString() === needle)
  );
}

export default function Transactions() {
  const { network } = useNetwork();
  const { data, loading, error, deployed, refresh } = useTransactions(network.id);
  const now = useNow(30_000);
  const [filter, setFilter] = useState<'all' | TxKind>('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [details, setDetails] = useState<Map<string, TxDetails>>(new Map());

  const all = data ?? [];
  const rows = useMemo(
    () => all.filter((t) => (filter === 'all' || t.kind === filter) && matches(t, details.get(t.hash)?.from, query.trim())),
    [all, filter, query, details]
  );
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const visible = rows.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE);

  // A new filter or search starts from the first page; staying on page 7 of a list that now has 2
  // is an empty table that looks like a broken one.
  useEffect(() => setPage(0), [filter, query, network.id]);
  useEffect(() => setDetails(new Map()), [network.id]);

  // Date and attribute only the rows on screen. The key is the set of hashes, so a poll that
  // returns the same page does not refetch it.
  const missing = visible.filter((t) => !details.has(t.hash));
  const missingKey = missing.map((t) => t.hash).join(',');
  useEffect(() => {
    if (!missing.length) return;
    let live = true;
    describeTxs(network.id, missing)
      .then((m) => {
        if (!live) return;
        setDetails((prev) => {
          const next = new Map(prev);
          for (const [k, v] of m) next.set(k, v);
          return next;
        });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missingKey, network.id]);

  const toggle = (hash: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      return next;
    });

  return (
    <main style={{ padding: 'var(--space-6)' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', gap: 'var(--space-3)', marginBottom: 'var(--space-2)' }}>
        <h1 style={{ fontSize: 28 }}>Transactions</h1>
        {data && (
          <span className="text-muted" style={{ fontSize: 12 }}>
            {all.length} {all.length === 1 ? 'transaction' : 'transactions'} on {network.name}
          </span>
        )}
      </div>

      <p className="text-muted" style={{ fontSize: 12, marginBottom: 'var(--space-4)' }}>
        Every transaction that touched a BotID contract (the router, registry, reputation engine,
        input attestor and verification adapters), read live from the chain. One row per
        transaction; open a row to see every event it emitted. For one row per request, see{' '}
        <Link href="/executions">Executions</Link>.
      </p>

      {error && (
        <div style={{ border: '1px solid var(--score-critical)', color: 'var(--score-critical)', padding: 'var(--space-3)', marginBottom: 'var(--space-4)', fontSize: 13, display: 'flex', gap: 'var(--space-3)', alignItems: 'baseline', flexWrap: 'wrap' }}>
          <span>Could not read the chain: {error}</span>
          <button className="btn btn-secondary" style={{ marginLeft: 'auto' }} onClick={refresh}>Try again</button>
        </div>
      )}

      {all.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 'var(--space-4)' }}>
          {FILTERS.map((f) => {
            const n = f.id === 'all' ? all.length : all.filter((t) => t.kind === f.id).length;
            return (
              <button key={f.id} className={`btn ${filter === f.id ? '' : 'btn-secondary'}`} onClick={() => setFilter(f.id)} style={{ fontSize: 12 }}>
                {f.label} <span className="tabular" style={{ opacity: 0.7 }}>{n}</span>
              </button>
            );
          })}
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search address, tx hash, request id or #agent"
            aria-label="Search transactions"
            style={{ flex: '1 1 240px', minWidth: 0, fontSize: 13, padding: '6px 10px', border: '1px solid var(--color-divider)', background: 'transparent', color: 'inherit', fontFamily: 'var(--font-mono)' }}
          />
        </div>
      )}

      {(visible.length > 0 || (deployed && loading)) && (
        <div className="table-scroll">
          <table className="table table-dense">
            <thead>
              <tr><th>Tx</th><th>Type</th><th>What happened</th><th>Agent</th><th>From</th><th>Time</th></tr>
            </thead>
            {deployed && loading && <TableSkeleton rows={6} widths={[104, 64, 220, 40, 96, 56]} />}
            <tbody>
              {visible.map((t) => {
                const d = details.get(t.hash);
                const meta = KIND_META[t.kind];
                const agentId = t.events.find((e) => e.agentId !== undefined)?.agentId;
                const requestId = t.events.find((e) => e.requestId)?.requestId;
                const isOpen = open.has(t.hash);
                return [
                  <tr key={t.hash}>
                    <td style={{ fontFamily: 'var(--font-mono)' }}>
                      <a href={explorerLink(network.id, 'tx', t.hash)} target="_blank" rel="noopener noreferrer">{shortHash(t.hash, 6)}</a>
                    </td>
                    <td>
                      <span className="tag" style={{ background: `color-mix(in srgb, ${meta.color} 18%, transparent)`, color: meta.color }}>{meta.label}</span>
                    </td>
                    <td style={{ fontSize: 13 }}>
                      {t.headline.detail}
                      {requestId && (
                        <>
                          {' · '}
                          <Link href={`/executions/${requestId}`} style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{shortHash(requestId, 4)}</Link>
                        </>
                      )}
                      {t.events.length > 1 && (
                        <button
                          onClick={() => toggle(t.hash)}
                          aria-expanded={isOpen}
                          className="text-muted"
                          style={{ marginLeft: 8, fontSize: 11, background: 'none', border: 'none', padding: 0, cursor: 'pointer', textDecoration: 'underline', color: 'inherit' }}
                        >
                          {isOpen ? 'hide' : `+${t.events.length - 1} event${t.events.length > 2 ? 's' : ''}`}
                        </button>
                      )}
                    </td>
                    <td style={{ fontFamily: 'var(--font-mono)' }}>
                      {agentId === undefined ? <span className="text-muted">—</span> : <Link href={`/agents/${agentId}`}>#{agentId.toString()}</Link>}
                    </td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                      {d?.from ? (
                        <a href={explorerLink(network.id, 'address', d.from)} target="_blank" rel="noopener noreferrer">{shortHash(d.from, 4)}</a>
                      ) : (
                        <span className="text-muted">…</span>
                      )}
                    </td>
                    <td className="text-muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                      {d?.time && now > 0 ? timeAgo(d.time, now) : `block ${t.block.toString()}`}
                    </td>
                  </tr>,
                  isOpen && (
                    <tr key={`${t.hash}:events`}>
                      <td />
                      <td colSpan={5} style={{ fontSize: 12 }}>
                        <ul style={{ margin: 0, paddingLeft: 16 }}>
                          {t.events.map((e, i) => (
                            <li key={i} style={{ marginBottom: 2 }}>
                              <span style={{ fontFamily: 'var(--font-mono)' }}>{e.contract}.{e.name}</span>
                              <span className="text-muted"> · {e.detail}</span>
                            </li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 && (
        <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', justifyContent: 'center', marginTop: 'var(--space-4)', fontSize: 13 }}>
          <button className="btn btn-secondary" disabled={current === 0} onClick={() => setPage(current - 1)}>Newer</button>
          <span className="text-muted tabular">Page {current + 1} of {pages}</span>
          <button className="btn btn-secondary" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>Older</button>
        </div>
      )}

      {!deployed && (
        <div style={{ textAlign: 'center', padding: 'var(--space-8) 0', color: 'var(--text-subtle)' }}>
          <p>BotID is not deployed on {network.name}, so there is nothing to read.</p>
        </div>
      )}

      {deployed && data && all.length === 0 && (
        <div style={{ textAlign: 'center', padding: 'var(--space-8) 0', color: 'var(--text-subtle)' }}>
          <p>No transactions on {network.name} yet. This table is empty because the chain is.</p>
        </div>
      )}

      {deployed && data && all.length > 0 && rows.length === 0 && (
        <div style={{ textAlign: 'center', padding: 'var(--space-8) 0', color: 'var(--text-subtle)' }}>
          <p style={{ fontSize: 13 }}>Nothing matches that filter or search.</p>
          <button className="btn btn-secondary" style={{ marginTop: 'var(--space-3)' }} onClick={() => { setFilter('all'); setQuery(''); }}>Show all</button>
        </div>
      )}
    </main>
  );
}

'use client';
import BotIdBadge from '@/components/BotIdBadge';
import { useNetwork } from '@/lib/network';
import { useAgents, useNow } from '@/lib/useChain';
import { registryAddress, tierNameOf } from '@/lib/registry';
import { explorerLink } from '@/lib/chain';
import { TIER_META, formatNum, timeAgo, scoreColorVar, shortHash } from '@/lib/format';
import { formatToken, pct } from '@/lib/token';

// Every number on this page is read from AgentRegistry. There is no SampleData banner because
// there is no sample data: the list is whatever `AgentRegistered` has emitted since DEPLOY_BLOCK,
// resolved through getAgent and getProfile.
//
// The two controls that used to sit above the table are gone with the fixtures they served. Sparse
// / Dense chose between two invented agent sets, and there is only one real one. "settled ≥ 5"
// filtered a generated population down to the part with enough history to rank; against the chain
// it would hide every agent that has just registered, which on a young network is all of them —
// a leaderboard that answers "who is here" with "nobody" because nobody is busy yet.

export default function Leaderboard() {
  const { network } = useNetwork();
  const { data: agents, loading, error, deployed, refresh } = useAgents(network.id);
  // Zero until the client has a clock. Relative times are rendered only alongside chain data, which
  // arrives strictly after that, so no row is ever dated against a zero.
  const now = useNow(30_000);

  const registry = registryAddress(network.id);
  // Score first, then bond, then id. The tiebreaks matter more here than on a busy leaderboard:
  // every agent starts at the same neutral score, so a fresh registry would otherwise order itself
  // by whatever the node happened to return.
  const list = [...(agents ?? [])].sort(
    (a, b) =>
      b.score - a.score ||
      (b.bond > a.bond ? 1 : b.bond < a.bond ? -1 : 0) ||
      (a.agentId > b.agentId ? 1 : -1)
  );

  return (
    <>
      <main style={{ padding: 'var(--space-6)' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', gap: 'var(--space-3)', marginBottom: 'var(--space-2)' }}>
          <h1 style={{ fontSize: 28 }}>Leaderboard</h1>
          {agents && (
            <span className="text-muted" style={{ fontSize: 12 }}>
              {agents.length} {agents.length === 1 ? 'agent' : 'agents'} on {network.name}
            </span>
          )}
        </div>

        {/* The provenance line. It replaces the Sample data banner and says the opposite thing, so
            it names the contract rather than merely asserting the data is real — a reader can open
            the address and check the event log for themselves. */}
        {registry && (
          <p className="text-muted" style={{ fontSize: 12, marginBottom: 'var(--space-4)' }}>
            Read live from AgentRegistry at{' '}
            <a href={explorerLink(network.id, 'address', registry)} target="_blank" rel="noopener noreferrer" style={{ fontFamily: 'var(--font-mono)' }}>
              {shortHash(registry, 6)}
            </a>
            . Scores, bonds and fault counts are contract state; there is no indexer behind this, so
            history and per-execution detail are not here yet.
          </p>
        )}

        {error && (
          <div style={{ border: '1px solid var(--score-critical)', color: 'var(--score-critical)', padding: 'var(--space-3)', marginBottom: 'var(--space-4)', fontSize: 13, display: 'flex', gap: 'var(--space-3)', alignItems: 'baseline', flexWrap: 'wrap' }}>
            <span>Could not read the registry: {error}</span>
            <button className="btn btn-secondary" style={{ marginLeft: 'auto' }} onClick={refresh}>Try again</button>
          </div>
        )}

        {/* Nine columns. On a phone this scrolls sideways inside .table-scroll rather than
            collapsing into cards: the whole point of a leaderboard is comparing a column down the
            page, and stacked cards destroy exactly that. */}
        {list.length > 0 && (
          <div className="table-scroll">
            <table className="table table-dense">
              <thead><tr><th>#</th><th>Agent</th><th>Score</th><th>Tier</th><th>Faults</th><th>Settled</th><th>Bond</th><th>Credit used</th><th>Last active</th></tr></thead>
              <tbody>
                {list.map((a, i) => {
                  const tier = tierNameOf(a.tier);
                  const tm = TIER_META[tier];
                  // lastActiveAt is seconds on chain and milliseconds everywhere in this interface.
                  // Zero means the agent has never been active, which is a different statement from
                  // "active in 1970" and is rendered as such.
                  const lastActive = Number(a.lastActiveAt) * 1000;
                  const isStale = lastActive > 0 && now > 0 && now - lastActive > 7 * 86400000;
                  const creditPct = pct(a.openNotional, a.maxOpenNotional);
                  return (
                    <tr key={a.agentId.toString()}>
                      <td className="tabular" style={{ color: 'var(--text-subtle)' }}>{i + 1}</td>
                      <td>
                        <a href={`/agents/${a.agentId}`} style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none', color: 'inherit' }}>
                          <BotIdBadge tier={tier} hasFault={a.faults > 0} />
                          <span>
                            <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }}>
                              #{a.agentId.toString()}
                              {/* Unbonded or retired agents stay on the board. Dropping them would
                                  quietly rewrite the record of who has operated here. */}
                              {!a.active && <span className="text-muted" style={{ fontWeight: 400, fontSize: 10, marginLeft: 6 }}>inactive</span>}
                            </div>
                            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-subtle)' }}>{shortHash(a.operator, 3)}</div>
                          </span>
                        </a>
                      </td>
                      <td className="tabular" style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: scoreColorVar(a.score) }}>{formatNum(a.score)}</td>
                      <td><span className="tag" style={{ background: `color-mix(in srgb, ${tm.color} 18%, transparent)`, color: tm.color }}>{tm.label}</span></td>
                      <td className="tabular" style={{ color: a.faults > 0 ? 'var(--score-critical)' : 'inherit', fontWeight: a.faults > 0 ? 800 : 400 }}>{a.faults}</td>
                      <td className="tabular">{a.settledExecutions}</td>
                      <td className="tabular" style={{ fontFamily: 'var(--font-mono)' }}>{formatToken(a.bond)}</td>
                      <td style={{ minWidth: 110 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <div style={{ flex: 1, height: 6, background: 'var(--color-neutral-200)' }}><div style={{ height: '100%', width: `${creditPct}%`, background: 'var(--color-accent)' }} /></div>
                          <span style={{ fontSize: 11 }} className="tabular">{creditPct}%</span>
                        </div>
                      </td>
                      <td style={{ fontSize: 12, color: isStale ? 'var(--color-neutral-500)' : 'inherit' }}>
                        {lastActive === 0 ? <span className="text-muted">never</span> : now === 0 ? '—' : timeAgo(lastActive, now)}
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
            <p>BotID is not deployed on {network.name}, so there is no registry to read.</p>
          </div>
        )}

        {deployed && loading && (
          <div style={{ textAlign: 'center', padding: 'var(--space-8) 0', color: 'var(--text-subtle)' }}>
            <p>Reading the registry on {network.name}…</p>
          </div>
        )}

        {/* An empty leaderboard is an answer, not a failure, and it only gets to say so once the
            node has actually answered — hence the guard on `agents` rather than on `!loading`. */}
        {deployed && agents && agents.length === 0 && (
          <div style={{ textAlign: 'center', padding: 'var(--space-8) 0', color: 'var(--text-subtle)' }}>
            <p style={{ marginBottom: 'var(--space-2)' }}>No agents registered yet.</p>
            <p style={{ fontSize: 13, marginBottom: 'var(--space-4)' }}>
              The contracts are live on {network.name} and nobody has registered against them. This
              table is empty because the chain is, not because the page failed to load.
            </p>
            <a href="/portal" className="btn btn-secondary" style={{ display: 'inline-flex' }}>Register an agent</a>
          </div>
        )}
      </main>
    </>
  );
}

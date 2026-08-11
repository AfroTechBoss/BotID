'use client';
import { useState } from 'react';
import BotIdBadge from '@/components/BotIdBadge';
import { useNetwork } from '@/lib/network';
import { useAgent, useAgentExecutions, useNow } from '@/lib/useChain';
import { registryAddress, tierNameOf } from '@/lib/registry';
import { explorerLink } from '@/lib/chain';
import { TIER_META, formatNum, timeAgo, scoreColorVar, shortHash } from '@/lib/format';
import { formatToken, ratio, pct } from '@/lib/token';
import type { ExecStatus } from '@/lib/activity';

// Read from the chain, like the leaderboard that links here. Until this page was converted, that
// link was actively misleading: a real row for a real agent opened a profile rendering a fixture,
// so agent #1 appeared to have ninety days of history and twenty executions on a registry that had
// been live for under an hour. A wrong number is worse when it is reached from a right one.
//
// Two things that were on this page are gone rather than converted.
//
// The 90-day score chart needed a score *history*, and ReputationEngine overwrites the score in
// place — the previous value is not stored anywhere on chain, and no event carries it. It could be
// reconstructed by replaying every settlement through the scoring formula, which is exactly the job
// an indexer exists to do. Drawing a line through one real point and eighty-nine invented ones is
// not a lesser version of that; it is a different claim entirely.
//
// The model panel's name, verifier and scale were three fixture strings. The commitment is a hash
// with no preimage on chain, so what it commits to is knowable only to whoever produced it. The
// panel now shows the fields the registry actually holds.

const STATUS_COLOR: Record<ExecStatus, string> = {
  Settled: 'var(--score-good)', Finalized: 'var(--tier-gold)', Challenged: 'var(--state-pending)',
  Faulted: 'var(--state-slashed)', Expired: 'var(--score-critical)',
  Delivered: 'var(--color-neutral-700)', Pending: 'var(--color-neutral-500)',
};

export default function AgentProfile({ params }: { params: { id: string } }) {
  const [filter, setFilter] = useState<'all' | 'settled' | 'challenged' | 'faulted'>('all');
  const { network } = useNetwork();

  // A route param is a string from the URL bar and nothing stops it being "abc". BigInt() throws on
  // one, which in a render is a blank page rather than a message, so it is parsed defensively.
  let agentId: bigint | undefined;
  try {
    if (/^\d+$/.test(params.id)) agentId = BigInt(params.id);
  } catch {
    agentId = undefined;
  }

  const { data: a, loading, error, deployed } = useAgent(network.id, agentId);
  const { data: execs } = useAgentExecutions(network.id, agentId);
  const now = useNow(30_000);
  const registry = registryAddress(network.id);

  if (agentId === undefined) {
    return <Empty title={`"${params.id}" is not an agent id.`} body="Agent ids are whole numbers, assigned in registration order." />;
  }
  if (!deployed) {
    return <Empty title={`BotID is not deployed on ${network.name}.`} body="There is no registry here to look this agent up in." />;
  }
  if (loading) {
    return <Empty title={`Reading agent #${params.id} on ${network.name}…`} body="" />;
  }
  // Two different absences, deliberately worded apart. With no error the registry answered and had
  // no such agent; with one it never answered at all. Collapsing them into "not found" would tell a
  // reader their agent had been deregistered when the truth was that the RPC was down.
  if (!a) {
    return (
      <Empty
        title={`No agent #${params.id} on ${network.name}.`}
        body={error ? `The registry did not return one: ${error}` : 'The registry has no record under that id.'}
      />
    );
  }

  const tier = tierNameOf(a.tier);
  const tm = TIER_META[tier];
  const lastActive = Number(a.lastActiveAt) * 1000;

  let rows = execs ?? [];
  if (filter === 'settled') rows = rows.filter((e) => e.status === 'Settled');
  if (filter === 'challenged') rows = rows.filter((e) => e.status === 'Challenged');
  if (filter === 'faulted') rows = rows.filter((e) => e.status === 'Faulted' || e.status === 'Expired');

  return (
    <>
      <main style={{ padding: 'var(--space-6)' }}>
        {/* Wraps: badge, id, score and the alert button are ~330px of content plus a 44px badge. */}
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 14, marginBottom: 4 }}>
          <BotIdBadge tier={tier} hasFault={a.faults > 0} size={44} />
          <h1 style={{ fontSize: 28, margin: 0 }}>agent #{a.agentId.toString()}</h1>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 700, color: scoreColorVar(a.score) }}>{formatNum(a.score)}</span>
          {a.faults > 0 && (
            <span className="tag" style={{ background: 'color-mix(in srgb, var(--score-critical) 16%, transparent)', color: 'var(--score-critical)' }}>
              {a.faults} {a.faults === 1 ? 'fault' : 'faults'}
            </span>
          )}
          {!a.active && <span className="tag">inactive</span>}
        </div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>
          <span className="tag" style={{ background: `color-mix(in srgb, ${tm.color} 18%, transparent)`, color: tm.color }}>{tm.label}</span>
          {' '}&middot; operator {shortHash(a.operator, 3)} &middot; owner {shortHash(a.owner, 3)} &middot; active{' '}
          {lastActive === 0 ? 'never' : now === 0 ? '—' : timeAgo(lastActive, now)}
        </div>
        {registry && (
          <p className="text-muted" style={{ fontSize: 12, marginBottom: 'var(--space-6)' }}>
            Read live from AgentRegistry at{' '}
            <a href={explorerLink(network.id, 'address', registry)} target="_blank" rel="noopener noreferrer" style={{ fontFamily: 'var(--font-mono)' }}>
              {shortHash(registry, 6)}
            </a>
            .
          </p>
        )}

        <section style={{ marginBottom: 'var(--space-8)' }}>
          <h6 style={{ marginBottom: 'var(--space-3)', color: 'var(--text-muted)' }}>Score</h6>
          <div style={{ borderTop: '2px solid var(--color-divider)', borderBottom: '2px solid var(--color-divider)', padding: 'var(--space-4)', display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 'var(--space-6)' }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 34, fontWeight: 700, color: scoreColorVar(a.score) }}>{formatNum(a.score)}</span>
            <span className="text-muted" style={{ fontSize: 13, flex: 1, minWidth: 260 }}>
              Current score out of 10,000, neutral at 5,000. It moves only on settled executions,
              weighted by the capital that was at risk. There is no history line here because the
              engine overwrites this number rather than appending to it — reconstructing the last
              ninety days means replaying every settlement, which is an indexer&apos;s job and one
              this interface does not have yet.
            </span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-subtle)', marginTop: 4 }}>
            {a.settledExecutions} settled &middot; {a.faults} {a.faults === 1 ? 'fault' : 'faults'} &middot; loss tolerance {a.lossToleranceBps} bps
          </div>
        </section>

        {/* .panel-split rather than an inline 1fr 1fr, so these two stack below 720px and the
            divider between them turns horizontal with them. */}
        <div className="panel-split" style={{ marginBottom: 'var(--space-8)' }}>
          <div style={{ padding: 'var(--space-4)' }}>
            <h6 style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-3)' }}>Credit</h6>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontFamily: 'var(--font-mono)', fontSize: 13 }}>
              <Row label="bond" val={formatToken(a.bond)} />
              <Row label="leverage" val={`${ratio(a.maxOpenNotional, a.bond).toFixed(1)}×`} />
              <Row label="max open" val={formatToken(a.maxOpenNotional)} />
              <Row label="open" val={formatToken(a.openNotional)} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
              <div style={{ flex: 1, height: 8, background: 'var(--color-neutral-200)' }}><div style={{ height: '100%', width: `${pct(a.openNotional, a.maxOpenNotional)}%`, background: 'var(--color-accent)' }} /></div>
              <span style={{ fontSize: 12 }} className="tabular">{pct(a.openNotional, a.maxOpenNotional)}%</span>
            </div>
          </div>
          <div style={{ padding: 'var(--space-4)' }}>
            <h6 style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-3)' }}>Registration</h6>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontFamily: 'var(--font-mono)', fontSize: 13 }}>
              <Row label="commitment" val={shortHash(a.modelCommitment)} />
              <Row label="tier" val={tm.label} />
              <Row label="status" val={a.active ? 'active' : 'inactive'} />
              <Row label="unbonding" val={a.unbondingAmount > 0n ? formatToken(a.unbondingAmount) : '–'} />
            </div>
            <p className="text-muted" style={{ fontSize: 11, marginTop: 8 }}>
              The commitment is a hash. What it commits to — weights, verifying key, declared limits —
              is known to whoever produced it, and nothing on chain reveals it.
            </p>
          </div>
        </div>

        <section>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-3)' }}>
            <h6 style={{ color: 'var(--text-muted)', margin: 0 }}>Executions</h6>
            <span className="seg" style={{ fontSize: 11, marginLeft: 'auto' }}>
              {(['all', 'settled', 'challenged', 'faulted'] as const).map((f) => (
                <label key={f} className="seg-opt"><input type="radio" checked={filter === f} onChange={() => setFilter(f)} />{f}</label>
              ))}
            </span>
          </div>
          {rows.length > 0 ? (
            <div className="table-scroll">
              <table className="table table-dense">
                <thead><tr><th>Request</th><th>Status</th><th>Notional</th><th>Outcome</th><th>Time</th></tr></thead>
                <tbody>
                  {rows.map((e) => (
                    <tr key={e.requestId}>
                      <td><a href={`/executions/${e.requestId}`} style={{ fontFamily: 'var(--font-mono)' }}>{shortHash(e.requestId)}</a></td>
                      <td><span className="tag" style={{ background: `color-mix(in srgb, ${STATUS_COLOR[e.status]} 16%, transparent)`, color: STATUS_COLOR[e.status] }}>{e.status}</span></td>
                      <td className="tabular">{e.notional === undefined ? '–' : formatToken(e.notional)}</td>
                      <td className="tabular" style={{ color: e.bps === undefined ? 'inherit' : e.bps >= 0 ? 'var(--score-good)' : 'var(--score-critical)' }}>
                        {e.bps === undefined ? '–' : `${e.bps >= 0 ? '+' : ''}${e.bps} bps`}
                      </td>
                      {/* Block number rather than a guessed age where the block was not dated —
                          it is the less useful of the two facts, but it is a fact. */}
                      <td style={{ fontSize: 12, color: 'var(--text-subtle)' }}>
                        {e.time > 0 && now > 0 ? timeAgo(e.time, now) : `#${e.block.toString()}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-muted" style={{ fontSize: 13, padding: 'var(--space-4) 0' }}>
              {execs === undefined
                ? 'Reading the router…'
                : (execs.length > 0
                  ? `No ${filter} executions. This agent has ${execs.length} in total.`
                  : 'Nothing has been commissioned from this agent yet. Every row here would be an ExecutionRouter event, so the first request anyone sends appears here.')}
            </p>
          )}
        </section>
      </main>
    </>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <main style={{ padding: 'var(--space-6)' }}>
      <div style={{ textAlign: 'center', padding: 'var(--space-8) 0', color: 'var(--text-subtle)' }}>
        <p style={{ marginBottom: 'var(--space-2)' }}>{title}</p>
        {body && <p style={{ fontSize: 13, marginBottom: 'var(--space-4)' }}>{body}</p>}
        <a href="/agents" className="btn btn-secondary" style={{ display: 'inline-flex' }}>Back to the leaderboard</a>
      </div>
    </main>
  );
}

function Row({ label, val }: { label: string; val: string }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="text-muted">{label}</span><span>{val}</span></div>;
}

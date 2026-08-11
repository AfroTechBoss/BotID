'use client';
import { useEffect, useState } from 'react';
import BotIdBadge from '@/components/BotIdBadge';
import { Bar, TableSkeleton } from '@/components/Skeleton';
import { useNetwork } from '@/lib/network';
import { useAgents, useActivity, useNow } from '@/lib/useChain';
import { tierNameOf } from '@/lib/registry';
import type { ChainEvent } from '@/lib/activity';
import { TIER_META, formatNum, timeAgo, scoreColorVar, shortHash, dayLabel } from '@/lib/format';
import { formatToken } from '@/lib/token';

// The overview reads the chain. Nothing on this page is generated any more:
//
//  · the four network stats are summed from AgentRegistry's getProfile,
//  · the bars are ExecutionDelivered logs bucketed by day,
//  · the feed is the router's lifecycle events, newest first,
//  · the block number is the head, polled.
//
// Two things left with the fixtures. The score delta beside each agent needed a score history and
// there is nothing on chain that stores one — the engine writes the current score and overwrites
// it, so a delta would have to come from an indexer diffing settlements. And "indexer lag 0.4s" in
// the status bar was a reading of a component that does not exist; a fabricated health metric next
// to three real ones is worse than no metric, because it makes the other three look invented too.

export default function Overview() {
  const { network } = useNetwork();
  const { data: agents, loading: agentsLoading, error: agentsError } = useAgents(network.id);
  const { data: activity, error: activityError, deployed } = useActivity(network.id);
  const now = useNow(1000);

  // Pause freezes what is on screen rather than stopping the poll. The poll is what keeps the block
  // counter and the stats moving, and someone pausing the feed to read a row is not asking for the
  // rest of the page to stop.
  const [frozen, setFrozen] = useState<ChainEvent[]>();
  const paused = frozen !== undefined;
  const feed = frozen ?? activity?.feed ?? [];

  // Cleared on a network change, so a paused feed cannot survive onto a different chain.
  useEffect(() => setFrozen(undefined), [network.id]);

  const totalNotional = (agents ?? []).reduce((s, a) => s + a.openNotional, 0n);
  const totalSettled = (agents ?? []).reduce((s, a) => s + a.settledExecutions, 0);
  const totalFaults = (agents ?? []).reduce((s, a) => s + a.faults, 0);
  const top = [...(agents ?? [])].sort((a, b) => b.score - a.score).slice(0, 6);

  const perDay = activity?.perDay ?? [];
  const maxDay = Math.max(1, ...perDay.map((d) => d.bronze + d.silver + d.gold));
  const chartTotal = perDay.reduce((s, d) => s + d.bronze + d.silver + d.gold, 0);

  const [hoverDay, setHoverDay] = useState<number | null>(null);

  const verbColor = (row: ChainEvent) => {
    if (row.verb === 'SETTLE') return (row.pnlBps ?? 0) >= 0 ? 'var(--score-good)' : 'var(--score-critical)';
    if (row.verb === 'DELIVER') return `var(--tier-${row.tier ?? 'bronze'})`;
    if (row.verb === 'CHALLENGE') return 'var(--state-pending)';
    if (row.verb === 'EXPIRE') return 'var(--score-critical)';
    if (row.verb === 'SLASH') return 'var(--state-slashed)';
    if (row.verb === 'RESOLVE') return 'var(--tier-gold)';
    if (row.verb === 'FINAL') return 'var(--text-muted)';
    return 'inherit';
  };

  // A bar rather than a zero wherever the node has not answered yet. Zero is a claim about the
  // chain; a placeholder is a claim about this page, and they are not the same statement. This was
  // an em dash, which is the same idea but reads as a real value that happens to be blank — several
  // of these numbers are legitimately zero on a young network, and "—" next to "0" invites the
  // reader to work out which is which. A bar cannot be mistaken for a number.
  //
  // Keyed on `loading`, not on `!agents`. Keyed on the data these bars pulsed forever when the read
  // failed, which is a placeholder that has stopped standing in for anything — the waiter left and
  // the table is still laid. A failed read gets an em dash: not a number, not a promise of one, and
  // the status bar in the footer already says the RPC is unreachable.
  const stat = (v: string | number) => (agents ? v : agentsLoading ? <Bar w="60%" h="0.8em" /> : '—');

  return (
    // Exactly one screenful. The two columns and the status bar divide it up; nothing here grows
    // the document, so the site footer below stays exactly one scroll away.
    //
    // That is the desktop premise, and .overview-grid / .overview-main in globals.css unwind it
    // below 900px: the columns stack, the inner scrollers give way to the page's own, and the feed
    // is bounded by a fraction of the screen rather than by a column height. It has to live in CSS
    // rather than here because a media query cannot reach an inline style.
    <div className="overview-shell">
      <div className="overview-grid">
        <main className="overview-main" style={{ padding: 'var(--space-6)', display: 'flex', flexDirection: 'column', gap: 'var(--space-8)' }}>
          <section>
            <h6 style={{ marginBottom: 'var(--space-3)', color: 'var(--text-muted)' }}>Network</h6>
            <div className="stat-strip">
              {[
                ['Agents', stat(agents?.length ?? 0), 'inherit'],
                ['Open notional', stat(formatToken(totalNotional)), 'inherit'],
                ['Settled', stat(formatNum(totalSettled)), 'inherit'],
                ['Faults', stat(totalFaults), totalFaults > 0 ? 'var(--score-critical)' : 'inherit'],
              ].map(([label, val, color]) => (
                <div key={label as string} style={{ padding: 'var(--space-4)' }}>
                  <div className="tabular stat-num" style={{ color: color as string }}>{val}</div>
                  <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-subtle)', marginTop: 4 }}>{label}</div>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h6 style={{ marginBottom: 'var(--space-3)', color: 'var(--text-muted)', display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 12 }}>
              Executions / day
              {/* The marks here used to be filled squares in the tier hue, which read as badges
                  and taught the wrong thing — a Bronze badge is a single *green* ring, and a solid
                  bronze block next to the word "Bronze" says otherwise. These are the real badges.
                  The colour key the squares used to provide moves onto the label text, which is
                  enough to match a word to a band, and the hover readout carries filled swatches
                  in the bar colours for anyone reading the numbers rather than the shape. */}
              <span style={{ textTransform: 'none', letterSpacing: 0, fontSize: 11, display: 'flex', gap: 12 }}>
                {(['bronze', 'silver', 'gold'] as const).map((t) => (
                  <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    {/* Hidden from assistive tech: the badge announces "Bronze tier, no faults"
                        and the word beside it already says Bronze. */}
                    <span aria-hidden="true" style={{ display: 'inline-flex' }}>
                      <BotIdBadge tier={t} hasFault={false} size={14} />
                    </span>
                    <span style={{ color: `var(--tier-${t})` }}>{TIER_META[t].label}</span>
                  </span>
                ))}
              </span>
            </h6>
            <div
              className="chart-wrap"
              style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 120, borderBottom: '2px solid var(--color-divider)', paddingBottom: 2, position: 'relative' }}
              onMouseLeave={() => setHoverDay(null)}
            >
              {perDay.map((d, i) => {
                const total = d.bronze + d.silver + d.gold;
                return (
                  <div
                    key={d.day}
                    className="chart-col"
                    data-active={hoverDay === i || undefined}
                    style={{ flex: 1, display: 'flex', flexDirection: 'column-reverse', height: '100%' }}
                    tabIndex={0}
                    // The readout is hover-only for a mouse, so the same numbers have to reach a
                    // keyboard and a screen reader some other way. This is that way.
                    aria-label={`${dayLabel(d.day)}: ${total} executions — ${d.bronze} bronze, ${d.silver} silver, ${d.gold} gold`}
                    onMouseEnter={() => setHoverDay(i)}
                    onFocus={() => setHoverDay(i)}
                    onBlur={() => setHoverDay(null)}
                  >
                    <div style={{ height: Math.round((d.bronze / maxDay) * 110), background: 'var(--tier-bronze)' }} />
                    <div style={{ height: Math.round((d.silver / maxDay) * 110), background: 'var(--tier-silver)' }} />
                    <div style={{ height: Math.round((d.gold / maxDay) * 110), background: 'var(--tier-gold)' }} />
                  </div>
                );
              })}

              {/* Sits inside the plot area rather than replacing it, so the axis and the fourteen
                  day columns stay put. An empty chart that keeps its shape reads as "nothing
                  happened"; one that collapses reads as "this did not load". */}
              {activity && chartTotal === 0 && (
                <div className="text-muted" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, pointerEvents: 'none' }}>
                  No executions in the last {perDay.length} days
                </div>
              )}

              {hoverDay !== null && perDay[hoverDay] && (
                <div
                  className="chart-tip"
                  style={{
                    left: `${((hoverDay + 0.5) / perDay.length) * 100}%`,
                    bottom: 'calc(100% + 8px)',
                    // Clamped at the ends rather than always centred: a centred tip on the first
                    // or last column hangs off the panel and gets clipped by the column that
                    // scrolls beside it.
                    transform: hoverDay <= 1 ? 'translateX(-20%)' : hoverDay >= perDay.length - 2 ? 'translateX(-80%)' : 'translateX(-50%)',
                  }}
                >
                  <div className="chart-tip-head">{dayLabel(perDay[hoverDay].day)}</div>
                  {(['bronze', 'silver', 'gold'] as const).map((t) => (
                    <div key={t} className="chart-tip-row">
                      <span aria-hidden="true" className="chart-tip-swatch" style={{ background: `var(--tier-${t})` }} />
                      <span>{TIER_META[t].label}</span>
                      <span>{perDay[hoverDay][t]}</span>
                    </div>
                  ))}
                  <div className="chart-tip-row chart-tip-total">
                    <span>Total</span>
                    <span>{perDay[hoverDay].bronze + perDay[hoverDay].silver + perDay[hoverDay].gold}</span>
                  </div>
                </div>
              )}
            </div>
          </section>

          <section>
            <h6 style={{ marginBottom: 'var(--space-3)', color: 'var(--text-muted)' }}>Top agents</h6>
            {(top.length > 0 || agentsLoading) && (
              <div className="table-scroll">
                <table className="table table-dense">
                  <thead><tr><th></th><th>Agent</th><th>Score</th><th>Tier</th><th>Notional</th><th>Settled</th><th>Faults</th></tr></thead>
                  {agentsLoading && <TableSkeleton rows={4} widths={[20, 36, 44, 52, 76, 18, 18]} />}
                  <tbody>
                    {top.map((a) => {
                      const tier = tierNameOf(a.tier);
                      const tm = TIER_META[tier];
                      return (
                        <tr key={a.agentId.toString()}>
                          <td><BotIdBadge tier={tier} hasFault={a.faults > 0} size={20} /></td>
                          <td><a href={`/agents/${a.agentId}`} style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>#{a.agentId.toString()}</a></td>
                          <td className="tabular" style={{ color: scoreColorVar(a.score), fontWeight: 600 }}>{formatNum(a.score)}</td>
                          <td><span className="tag" style={{ background: `color-mix(in srgb, ${tm.color} 18%, transparent)`, color: tm.color }}>{tm.label}</span></td>
                          <td className="tabular">{formatToken(a.openNotional)}</td>
                          <td className="tabular">{a.settledExecutions}</td>
                          <td className="tabular" style={{ color: a.faults > 0 ? 'var(--score-critical)' : 'inherit', fontWeight: a.faults > 0 ? 800 : 400 }}>{a.faults}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {agentsLoading && <span className="sr-only" role="status">Loading agents on {network.name}</span>}
            {/* Without this the table simply was not rendered when the read failed — no rows, no
                skeleton, no heading body, no explanation. A blank space under a heading reads as
                "there are none", which is a claim about the registry we had not earned. */}
            {!agents && !agentsLoading && agentsError && (
              <p className="text-muted" style={{ fontSize: 12 }}>
                The registry could not be read: {agentsError}
              </p>
            )}
            {agents && agents.length === 0 && (
              <p className="text-muted" style={{ fontSize: 12 }}>
                No agents registered on {network.name} yet. The contracts are deployed and nobody has
                bonded against them — an empty table here is the chain&apos;s answer, not a failed
                request. <a href="/portal">Register one</a>.
              </p>
            )}
          </section>
        </main>

        <aside style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ padding: 'var(--space-3) var(--space-4)', borderBottom: '2px solid var(--color-divider)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: activityError ? 'var(--score-critical)' : 'var(--live)' }} />
            <h6 style={{ margin: 0 }}>Live feed</h6>
            <button
              className="btn btn-ghost"
              style={{ marginLeft: 'auto', fontSize: 12 }}
              onClick={() => setFrozen((f) => (f ? undefined : activity?.feed ?? []))}
            >
              {paused ? 'Resume' : 'Pause'}
            </button>
          </div>
          <div className="feed-scroll" style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
            {feed.map((row) => (
              <a key={row.id} href={`/executions/${row.requestId}`} style={{ display: 'block', textDecoration: 'none', color: 'inherit', padding: '8px 12px', borderBottom: '1px solid var(--color-divider)' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                  <span style={{ color: 'var(--text-subtle)', flex: 'none', width: 56 }}>
                    {row.time > 0 && now > 0 ? timeAgo(row.time, now) : `#${row.block}`}
                  </span>
                  <span style={{ fontWeight: 700, flex: 'none', width: 70, color: verbColor(row) }}>{row.verb}</span>
                  <span style={{ color: 'color-mix(in srgb, var(--color-text) 70%, transparent)' }}>{shortHash(row.requestId)}</span>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 2, paddingLeft: 64 }}>
                  {row.agentId !== undefined && <span style={{ color: 'var(--text-muted)' }}>agent #{row.agentId.toString()}</span>}
                  <span>{row.detail}</span>
                </div>
              </a>
            ))}
            {activity && feed.length === 0 && (
              <div className="text-muted" style={{ padding: 'var(--space-4)', fontFamily: 'var(--font-body)', fontSize: 12 }}>
                No executions on {network.name} yet. This feed is ExecutionRouter&apos;s own event
                log, so the first request anyone sends appears here.
              </div>
            )}
            {/* Six rows in the feed's own two-line shape — a timestamp, a verb and a hash over a
                detail line — rather than six identical bars. The feed is the part of this page a
                reader watches, so it is the part where a placeholder that keeps the rhythm of the
                real thing is worth the markup. */}
            {/* A read that failed is not a read still running. `!activity` alone kept the skeleton
                on screen forever whenever the log scan threw, which is the worst of both: the page
                claims to be working and the reader waits on something that already stopped. */}
            {!activity && deployed && activityError && (
              <div className="text-muted" style={{ padding: 'var(--space-4)', fontFamily: 'var(--font-body)', fontSize: 12 }}>
                The feed could not be read: {activityError}
              </div>
            )}
            {!activity && deployed && !activityError && (
              <div aria-busy="true">
                <span className="sr-only" role="status">Loading the execution feed</span>
                {Array.from({ length: 6 }, (_, i) => (
                  <div key={i} style={{ padding: '8px 12px', borderBottom: '1px solid var(--color-divider)' }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                      <Bar w={40} h={11} />
                      <Bar w={56} h={11} />
                      <Bar w={84} h={11} />
                    </div>
                    <div style={{ marginTop: 4, paddingLeft: 64 }}>
                      <Bar w={i % 2 ? '52%' : '68%'} h={11} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>
      </div>
      {/* One line at every width — see .overview-status. The type and the gutters are sized in the
          stylesheet because both have to shrink on a phone to keep the readings on one row, and a
          media query cannot reach an inline style. */}
      <footer className="overview-status">
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: activityError ? 'var(--score-critical)' : 'var(--live)' }} />
          {activityError ? 'RPC unreachable' : 'RPC live'}
        </span>
        <span>block {activity ? formatNum(Number(activity.head)) : '—'}</span>
        <span style={{ marginLeft: 'auto' }}>{network.short}</span>
      </footer>
    </div>
  );
}

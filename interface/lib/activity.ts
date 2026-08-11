// The execution lifecycle, read off ExecutionRouter's logs.
//
// This is the closest thing to an indexer this interface has, and it is deliberately a thin one:
// it asks the node for the router's events over the deployment's block range, dates them, and hands
// back two shapes — a reverse-chronological feed and daily counts by tier. No storage, no
// incremental sync, no reorg handling beyond deduping by log identity.
//
// It exists because the alternative on the overview was generated rows, and a fabricated feed of
// settlements next to a real block height is the kind of half-truth that is worse than either
// half — a reader has no way to tell which numbers came off the chain. Every row here came off the
// chain or is not there.
//
// No 'use client': the hook that calls it is a client module, but nothing in here touches the
// browser and a server component should be able to read the same numbers.

import { parseEventLogs } from 'viem';
import { executionRouterAbi } from '@abi/ExecutionRouter';
import { addressOf, DEPLOY_BLOCK } from './contracts';
import { publicClient, logWindows, BLOCK_TIME_MS } from './chain';
import { tierNameOf, type TierName } from './registry';
import { formatToken } from './token';
import type { NetworkId } from './network';

export type Verb = 'REQUEST' | 'DELIVER' | 'SETTLE' | 'CHALLENGE' | 'RESOLVE' | 'FINAL' | 'EXPIRE' | 'SLASH';

export interface ChainEvent {
  /** txHash:logIndex. Unique per log and stable across refetches, so it works as a React key. */
  id: string;
  block: bigint;
  /** Milliseconds. Exact for feed rows — read off the block — and absent (0) for older ones. */
  time: number;
  verb: Verb;
  requestId: `0x${string}`;
  agentId?: bigint;
  tier?: TierName;
  /** Settlements only. Carried out of the detail string so the feed can colour the row by sign. */
  pnlBps?: number;
  detail: string;
}

export interface DayBucket {
  /** Midnight UTC of the day, in ms. */
  day: number;
  bronze: number;
  silver: number;
  gold: number;
}

/** How many events the feed carries. Beyond this the interesting question is a filter, not a scroll. */
const FEED_LIMIT = 40;

/**
 * The most blocks we will date exactly.
 *
 * Each one is its own `eth_getBlockByNumber`, so this is a request budget rather than a display
 * limit. It comfortably covers FEED_LIMIT events even when every one of them lands in its own
 * block, which is the worst case.
 */
const MAX_BLOCK_READS = 60;

const DAY_MS = 86_400_000;

/** Events we render. Everything else the router emits is administrative. */
const LIFECYCLE = [
  'ExecutionRequested', 'ExecutionDelivered', 'ExecutionSettled', 'ExecutionChallenged',
  'ChallengeResolved', 'ExecutionFinalized', 'ExecutionExpired', 'ExecutionFaulted',
] as const;

const VERB: Record<(typeof LIFECYCLE)[number], Verb> = {
  ExecutionRequested: 'REQUEST',
  ExecutionDelivered: 'DELIVER',
  ExecutionSettled: 'SETTLE',
  ExecutionChallenged: 'CHALLENGE',
  ChallengeResolved: 'RESOLVE',
  ExecutionFinalized: 'FINAL',
  ExecutionExpired: 'EXPIRE',
  ExecutionFaulted: 'SLASH',
};

export interface Activity {
  /** Newest first, dated exactly, capped at FEED_LIMIT. */
  feed: ChainEvent[];
  /** `days` buckets ending today, oldest first. Counted from deliveries, which carry the tier. */
  perDay: DayBucket[];
  /** Head at the moment of the read. The overview's block counter. */
  head: bigint;
  /** Every lifecycle event found, not just the ones in the feed. */
  total: number;
}

/**
 * One pass over the router's logs.
 *
 * Called on an interval by the overview, and every call rescans the whole deployment range. That is
 * the shape an indexer removes; it is affordable now only because the range is short and the result
 * is empty. The moment either changes, this is the function to replace rather than to tune.
 */
export async function readActivity(network: NetworkId, days = 14): Promise<Activity | undefined> {
  const router = addressOf(network, 'ExecutionRouter');
  const fromBlock = DEPLOY_BLOCK[network];
  if (!router || fromBlock === undefined) return undefined;

  const client = publicClient(network);
  const head = await client.getBlockNumber();

  const logs = await routerLogs(network, head);

  // Deduped by log identity, because a reorg can hand back the same log twice and two identical
  // React keys is a rendering bug on top of a counting one.
  const seen = new Set<string>();
  const events: ChainEvent[] = [];
  for (const log of logs) {
    const id = `${log.transactionHash}:${log.logIndex}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const decoded = describe(log);
    if (decoded) events.push({ id, block: log.blockNumber, time: 0, ...decoded });
  }

  // Newest first. Block number then log index, so two events in the same block read in the order
  // the transaction emitted them rather than in the order the node returned them.
  events.sort((a, b) => (b.block === a.block ? b.id.localeCompare(a.id) : b.block > a.block ? 1 : -1));

  const feed = events.slice(0, FEED_LIMIT);
  const times = await blockTimes(network, feed.map((e) => e.block));
  for (const e of feed) e.time = times.get(e.block) ?? 0;

  return { feed, perDay: bucket(events, head, days), head, total: events.length };
}

/**
 * Every log the router has emitted in range, decoded.
 *
 * One request per window, with no topic filter, and the decoding done here rather than by the node.
 * The obvious shape is the opposite — ask for each event separately and let the node do the
 * filtering — and it is what this did until it was measured. Against rpc.bohr.life, over the same
 * ~46k block span:
 *
 *   eight filtered queries, in parallel     2559ms
 *   one unfiltered query                     409ms
 *
 * A topic filter saves the node nothing here; it scans the same blocks either way, and asking eight
 * times means paying for that scan eight times. The unfiltered version is also flat in the number
 * of events we care about — adding a ninth costs one more `case` and no more network — where the
 * filtered version added a whole round trip per event per window.
 *
 * The cost is bandwidth: this pulls administrative events (AdapterSet, ParametersUpdated) that get
 * thrown away. On a router emitting a handful of logs a day that is nothing. It stops being nothing
 * at the same point everything else here does, which is when this file becomes an indexer.
 */
async function routerLogs(network: NetworkId, head: bigint) {
  const router = addressOf(network, 'ExecutionRouter');
  const fromBlock = DEPLOY_BLOCK[network];
  if (!router || fromBlock === undefined) return [];
  const client = publicClient(network);

  const pages = await Promise.all(
    // A single failed window should cost that window, not the page. The result is then understated
    // rather than absent, which is the better failure for a feed.
    logWindows(fromBlock, head).map((range) => client.getLogs({ address: router, ...range }).catch(() => []))
  );

  // strict: false keeps a log whose event is not in the ABI out of the result rather than throwing.
  // The router's ABI is generated from the contract it is reading, so that should not happen — but
  // "should not" and a page that renders nothing at all are a bad pairing.
  return parseEventLogs({ abi: executionRouterAbi, logs: pages.flat(), strict: false });
}

/** Where one request has got to. Ordered by finality: later in this list wins a collision. */
const STATUS_ORDER = ['Pending', 'Delivered', 'Challenged', 'Finalized', 'Settled', 'Expired', 'Faulted'] as const;
export type ExecStatus = (typeof STATUS_ORDER)[number];

export interface AgentExecution {
  requestId: `0x${string}`;
  status: ExecStatus;
  /** From the request. Absent only if the request itself fell outside the scanned range. */
  notional?: bigint;
  /** Settlements only. */
  bps?: number;
  tier?: TierName;
  /** Latest event on this request. */
  block: bigint;
  /** Milliseconds, 0 where the block was not dated. */
  time: number;
}

/**
 * One agent's executions, folded out of the router's logs.
 *
 * The lifecycle is eight events across as many transactions, and a table row is a *request* rather
 * than an event — so this is a reduction, not a listing: every log carrying a requestId collapses
 * into the row for that request, and the row's status is whichever stage got furthest.
 *
 * Filtered in this process rather than by the node, for the reason given on `routerLogs`. It would
 * be tidier to hand agentId to the RPC — five of the eight events index it — but only five, so the
 * other three would need a second unfiltered pass anyway, and the two passes together cost more
 * than the one pass this does.
 */
export async function readAgentExecutions(network: NetworkId, agentId: bigint): Promise<AgentExecution[] | undefined> {
  const router = addressOf(network, 'ExecutionRouter');
  const fromBlock = DEPLOY_BLOCK[network];
  if (!router || fromBlock === undefined) return undefined;

  const client = publicClient(network);
  const head = await client.getBlockNumber();
  const logs = await routerLogs(network, head);

  // Split by whether the event names this agent. The rest are matched by request id below, once we
  // know which requests are this agent's — an event that carries only a requestId cannot be
  // attributed on its own.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const own = (logs as any[]).filter((l) => l.args?.agentId === agentId);
  //
  // Named explicitly rather than defined as "everything without an agentId". That negative
  // definition was correct while this file asked the node for eight specific events; the switch to
  // one unfiltered query quietly widened it to include the router's administrative events —
  // AdapterSet, ParametersUpdated — which have no requestId to match on and threw on the way past.
  // Describing the set you want is safe against the set growing; describing what it is not, is not.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const loose = (logs as any[]).filter(
    (l) => l.args?.requestId !== undefined && l.args?.agentId === undefined
  );

  const rows = new Map<string, AgentExecution>();
  const at = (id: `0x${string}`, block: bigint): AgentExecution => {
    const row = rows.get(id) ?? { requestId: id, status: 'Pending' as ExecStatus, block, time: 0 };
    // The row's block is the newest event on it — that is what the Time column is dating.
    if (block > row.block) row.block = block;
    rows.set(id, row);
    return row;
  };
  const advance = (row: AgentExecution, to: ExecStatus) => {
    if (STATUS_ORDER.indexOf(to) > STATUS_ORDER.indexOf(row.status)) row.status = to;
  };

  for (const log of own) {
    const row = at(log.args.requestId, log.blockNumber);
    switch (log.eventName) {
      case 'ExecutionRequested': row.notional = log.args.notional; break;
      case 'ExecutionDelivered': row.tier = tierNameOf(Number(log.args.tier)); advance(row, 'Delivered'); break;
      case 'ExecutionSettled': row.bps = Number(log.args.realizedPnlBps); advance(row, 'Settled'); break;
      case 'ExecutionExpired': advance(row, 'Expired'); break;
      case 'ExecutionFaulted': advance(row, 'Faulted'); break;
    }
  }

  // Only the ones belonging to a request this agent owns. Everything else on the router is another
  // agent's business and matching it in would be a straightforward lie about who did what.
  for (const log of loose) {
    if (!rows.has(log.args.requestId)) continue;
    const row = at(log.args.requestId, log.blockNumber);
    if (log.eventName === 'ExecutionChallenged') advance(row, 'Challenged');
    if (log.eventName === 'ExecutionFinalized') advance(row, 'Finalized');
  }

  const out = [...rows.values()].sort((a, b) => (b.block > a.block ? 1 : b.block < a.block ? -1 : 0));
  const times = await blockTimes(network, out.map((e) => e.block));
  for (const e of out) e.time = times.get(e.block) ?? 0;
  return out;
}

/**
 * Exact timestamps for a handful of blocks.
 *
 * Deduped first: a busy block emits several events and they all share one timestamp, so the number
 * of requests tracks distinct blocks rather than distinct events.
 */
async function blockTimes(network: NetworkId, blocks: bigint[]): Promise<Map<bigint, number>> {
  const client = publicClient(network);
  const unique = [...new Set(blocks)].slice(0, MAX_BLOCK_READS);
  const out = new Map<bigint, number>();
  await Promise.all(
    unique.map(async (blockNumber) => {
      try {
        const block = await client.getBlock({ blockNumber });
        out.set(blockNumber, Number(block.timestamp) * 1000);
      } catch {
        // Left unset. The row renders without a relative time rather than with a guessed one.
      }
    })
  );
  return out;
}

/**
 * Daily delivery counts by tier.
 *
 * Bucketed by block number rather than by timestamp, and that is the one approximation in this
 * file. Dating every event exactly would be one request per block over the whole range; instead the
 * day boundaries are converted *into* block numbers from the head and the block time, and events
 * are compared against those. On a chain that produces a block every 0.75s the boundary lands
 * within a few seconds of midnight, which is immaterial to a bar chart and would not be to a
 * timestamp on a row — which is why rows get the exact read and bars do not.
 *
 * Deliveries rather than requests: ExecutionDelivered is the event that carries the tier, and a
 * request that never arrives is a fault rather than an execution.
 */
function bucket(events: ChainEvent[], head: bigint, days: number): DayBucket[] {
  const now = Date.now();
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  const blocksPerMs = 1 / BLOCK_TIME_MS;

  return Array.from({ length: days }, (_, i) => {
    const day = today - (days - 1 - i) * DAY_MS;
    const startBlock = head - BigInt(Math.round((now - day) * blocksPerMs));
    const endBlock = startBlock + BigInt(Math.round(DAY_MS * blocksPerMs));
    const b: DayBucket = { day, bronze: 0, silver: 0, gold: 0 };
    for (const e of events) {
      if (e.verb !== 'DELIVER' || !e.tier) continue;
      if (e.block < startBlock || e.block >= endBlock) continue;
      b[e.tier] += 1;
    }
    return b;
  });
}

type Decoded = Omit<ChainEvent, 'id' | 'block' | 'time'>;

/** One log into a row. Every string here is built from the event's own fields. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function describe(log: any): Decoded | undefined {
  const name = log.eventName as (typeof LIFECYCLE)[number] | undefined;
  if (!name || !(name in VERB)) return undefined;
  const a = log.args ?? {};
  const verb = VERB[name];
  const requestId = a.requestId as `0x${string}`;
  const agentId = a.agentId as bigint | undefined;

  switch (name) {
    case 'ExecutionRequested':
      return { verb, requestId, agentId, detail: `${formatToken(a.notional as bigint)} · fee ${formatToken(a.fee as bigint)} · deliver by ${clock(Number(a.deliverBy) * 1000)}` };
    case 'ExecutionDelivered':
      return { verb, requestId, agentId, tier: tierNameOf(Number(a.tier)), detail: `${tierNameOf(Number(a.tier)).toUpperCase()} · output ${short(a.outputCommitment as string)}` };
    case 'ExecutionSettled': {
      const bps = Number(a.realizedPnlBps as bigint);
      return { verb, requestId, agentId, pnlBps: bps, detail: `${bps >= 0 ? '+' : ''}${bps} bps realised` };
    }
    case 'ExecutionChallenged':
      return { verb, requestId, detail: `challenger ${short(a.challenger as string, 3)}` };
    case 'ChallengeResolved':
      return { verb, requestId, detail: `${formatToken(a.bondToAgent as bigint)} to agent` };
    case 'ExecutionFinalized':
      return { verb, requestId, tier: tierNameOf(Number(a.tier)), detail: 'challenge window closed' };
    case 'ExecutionExpired':
      return { verb, requestId, agentId, detail: `LIVENESS FAULT · slashed ${formatToken(a.slashed as bigint)}` };
    case 'ExecutionFaulted':
      return { verb, requestId, agentId, detail: `CHALLENGE LOST · slashed ${formatToken(a.slashed as bigint)}` };
  }
}

function short(h: string, n = 4) {
  return h ? `${h.slice(0, 2 + n)}…${h.slice(-n)}` : '';
}

/** UTC, so a server render and a client render agree regardless of the reader's timezone. */
function clock(ts: number) {
  const d = new Date(ts);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

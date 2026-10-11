// Every transaction that touched BotID, read off the protocol's own logs.
//
// activity.ts reads one contract — the router — because the overview only cares about the
// execution lifecycle. This reads all of them: registrations, bonds, unbonding, slashes, pauses,
// reputation writes, publisher changes and admin wiring, as well as the lifecycle. A transaction
// is the unit, not a log, because one call routinely emits several events across contracts — a
// settle is ExecutionSettled on the router, OutcomeRecorded on the engine and ExposureChanged on
// the registry — and three rows for one thing a person did reads as three things.
//
// Same constraints as activity.ts and the same answer to them: no indexer, so every read rescans
// from the deploy block. One getLogs per window with every protocol address in it, decoded here,
// for the reason measured on `routerLogs`. Datable only a page at a time — each timestamp and each
// sender is its own request — so this hands back undated rows and `describeTxs` fills in the ones a
// reader is actually looking at.
//
// The bond token is deliberately not scanned. Its Transfer events are the money moving *inside*
// protocol calls this already lists, plus every unrelated USDT transfer on the chain.

import { parseEventLogs, type Abi } from 'viem';
import {
  agentRegistryAbi,
  executionRouterAbi,
  reputationEngineAbi,
  inputAttestorAbi,
  signatureAdapterAbi,
  teeAdapterAbi,
  zkAdapterAbi,
} from '@abi';
import { addressOf, DEPLOY_BLOCK, type ContractName } from './contracts';
import { publicClient, logWindows } from './chain';
import { blockTimes } from './activity';
import { tierNameOf } from './registry';
import { formatToken } from './token';
import type { NetworkId } from './network';

/** What a reader filters on. Coarser than event names, which nobody outside the codebase knows. */
export type TxKind = 'execution' | 'fault' | 'agent' | 'bond' | 'reputation' | 'admin';

export interface ProtocolEvent {
  contract: ContractName;
  name: string;
  kind: TxKind;
  /** One line, built only from the event's own fields. */
  detail: string;
  agentId?: bigint;
  requestId?: `0x${string}`;
  /** Every address the event names, lowercased. What the search box matches against. */
  addresses: string[];
}

export interface ProtocolTx {
  hash: `0x${string}`;
  block: bigint;
  /** First log index in the tx, so two transactions in one block keep their on-chain order. */
  firstLog: number;
  events: ProtocolEvent[];
  /** The most significant kind among the events, which is what the row is coloured and filtered by. */
  kind: TxKind;
  /** The headline event: the one a person called the function to cause. */
  headline: ProtocolEvent;
}

export interface TxHistory {
  txs: ProtocolTx[];
  /**
   * The protocol's owner on this network, lowercased: the deployer, who also sends every setup and
   * parameter call. Read from the registry rather than written down, so a handover is reflected
   * the moment it lands. What lets a row say "protocol owner" instead of leaving a reader to guess
   * whether an address is the team or a user.
   */
  owner?: string;
}

export interface TxDetails {
  /** Milliseconds; absent where the block read failed. */
  time?: number;
  from?: `0x${string}`;
}

/** The contracts scanned and the ABI each is decoded with. Halo2Verifier emits nothing. */
const SCANNED: [ContractName, Abi][] = [
  ['ExecutionRouter', executionRouterAbi as Abi],
  ['AgentRegistry', agentRegistryAbi as Abi],
  ['ReputationEngine', reputationEngineAbi as Abi],
  ['InputAttestor', inputAttestorAbi as Abi],
  ['SignatureAdapter', signatureAdapterAbi as Abi],
  ['TeeAdapter', teeAdapterAbi as Abi],
  ['ZkAdapter', zkAdapterAbi as Abi],
];

/**
 * Significance, highest first. A transaction's kind is its most significant event's kind, and its
 * headline is that event — so a settle that also nudged exposure and wrote a score reads as a
 * settlement, and a lost challenge reads as a fault rather than as the exposure release inside it.
 */
const KIND_RANK: TxKind[] = ['fault', 'execution', 'agent', 'bond', 'admin', 'reputation'];

/** Secondary events: side effects of a call that already has a better headline. */
const SECONDARY = new Set(['ExposureChanged', 'OutcomeRecorded', 'FaultRecorded', 'AgentInitialized', 'VoiceEarned', 'WorkAttributed', 'Slashed', 'TierDemonstrated']);

export async function readTransactions(network: NetworkId): Promise<TxHistory | undefined> {
  const fromBlock = DEPLOY_BLOCK[network];
  const contracts = SCANNED.flatMap(([name, abi]) => {
    const address = addressOf(network, name);
    return address ? [{ name, abi, address: address.toLowerCase() }] : [];
  });
  if (fromBlock === undefined || !contracts.length) return undefined;

  const client = publicClient(network);
  const head = await client.getBlockNumber();
  const registry = addressOf(network, 'AgentRegistry');
  const ownerRead = registry
    ? client
        .readContract({ address: registry, abi: agentRegistryAbi as Abi, functionName: 'owner' })
        .then((o) => String(o).toLowerCase())
        .catch(() => undefined)
    : Promise.resolve(undefined);
  const pages = await Promise.all(
    // A failed window costs that window, not the page; see `routerLogs`.
    logWindows(network, fromBlock, head).map((range) =>
      client.getLogs({ address: contracts.map((c) => c.address as `0x${string}`), ...range }).catch(() => [])
    )
  );
  const raw = pages.flat();

  const txs = new Map<string, ProtocolTx>();
  const seen = new Set<string>();
  for (const c of contracts) {
    const mine = raw.filter((l) => l.address.toLowerCase() === c.address);
    // strict: false drops a log the ABI does not know rather than throwing on it.
    for (const log of parseEventLogs({ abi: c.abi, logs: mine, strict: false })) {
      const key = `${log.transactionHash}:${log.logIndex}`;
      if (seen.has(key) || !log.transactionHash || log.blockNumber === null) continue;
      seen.add(key);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ev = describe(c.name, (log as any).eventName, ((log as any).args ?? {}) as Record<string, unknown>);
      const hash = log.transactionHash as `0x${string}`;
      const tx = txs.get(hash) ?? { hash, block: log.blockNumber, firstLog: log.logIndex ?? 0, events: [], kind: ev.kind, headline: ev };
      tx.firstLog = Math.min(tx.firstLog, log.logIndex ?? 0);
      tx.events.push(ev);
      txs.set(hash, tx);
    }
  }

  for (const tx of txs.values()) {
    const ranked = [...tx.events].sort((a, b) => weight(a) - weight(b));
    tx.headline = ranked[0];
    tx.kind = ranked[0].kind;
  }

  const sorted = [...txs.values()].sort((a, b) =>
    b.block === a.block ? b.firstLog - a.firstLog : b.block > a.block ? 1 : -1
  );
  return { txs: sorted, owner: await ownerRead };
}

/** Lower is more significant. Primary events beat side effects, then by kind. */
function weight(e: ProtocolEvent) {
  return (SECONDARY.has(e.name) ? 100 : 0) + KIND_RANK.indexOf(e.kind);
}

/**
 * Timestamps and senders for the rows on screen.
 *
 * One block read per distinct block and one transaction read per row, all batched by the client.
 * Called per page rather than for the whole history, because the whole history is one request per
 * transaction the protocol has ever seen.
 */
export async function describeTxs(network: NetworkId, txs: ProtocolTx[]): Promise<Map<string, TxDetails>> {
  const client = publicClient(network);
  const [times, senders] = await Promise.all([
    blockTimes(network, txs.map((t) => t.block)),
    Promise.all(
      txs.map((t) =>
        client.getTransaction({ hash: t.hash }).then((r) => [t.hash, r.from] as const).catch(() => [t.hash, undefined] as const)
      )
    ),
  ]);
  const out = new Map<string, TxDetails>();
  for (const t of txs) out.set(t.hash, { time: times.get(t.block) });
  for (const [hash, from] of senders) out.get(hash)!.from = from;
  return out;
}

// ------------------------------------------------------------------------------- decoding

const amt = (v: unknown) => formatToken(v as bigint);
const addr = (v: unknown) => String(v ?? '');
const shortAddr = (v: unknown) => {
  const s = addr(v);
  return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
};
const tier = (v: unknown) => tierNameOf(Number(v)).toUpperCase();
const until = (v: unknown) => new Date(Number(v) * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

/** One event into a row line. Unknown events still render, as their name and raw fields. */
function describe(contract: ContractName, name: string, a: Record<string, unknown>): ProtocolEvent {
  const agentId = typeof a.agentId === 'bigint' ? a.agentId : undefined;
  const requestId = typeof a.requestId === 'string' ? (a.requestId as `0x${string}`) : undefined;
  const addresses = Object.values(a)
    .filter((v): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v))
    .map((v) => v.toLowerCase());
  const base = { contract, name, agentId, requestId, addresses };
  const ev = (kind: TxKind, detail: string): ProtocolEvent => ({ ...base, kind, detail });

  switch (name) {
    // Router: the lifecycle.
    case 'ExecutionRequested':
      return ev('execution', `Requested ${amt(a.notional)} of work, fee ${amt(a.fee)}`);
    case 'ExecutionDelivered':
      return ev('execution', `Delivered at ${tier(a.tier)}`);
    case 'ExecutionFinalized':
      return ev('execution', `Finalized at ${tier(a.tier)}; challenge window closed`);
    case 'ExecutionSettled': {
      const bps = Number(a.realizedPnlBps as bigint);
      return ev('execution', `Settled at ${bps >= 0 ? '+' : ''}${bps} bps`);
    }
    case 'ExecutionRejected':
      return ev('execution', `Rejected by the agent; fee refunded to ${shortAddr(a.consumer)}`);
    case 'ExecutionChallenged':
      return ev('fault', `Challenged by ${shortAddr(a.challenger)}`);
    case 'ChallengeResolved':
      return ev('execution', `Challenge answered with a Gold proof; ${amt(a.bondToAgent)} to the agent`);
    case 'ExecutionExpired':
      return ev('fault', `Expired undelivered; liveness slash ${amt(a.slashed)}`);
    case 'ExecutionFaulted':
      return ev('fault', `Challenge unanswered; slashed ${amt(a.slashed)}`);

    // Registry: identity and capital.
    case 'AgentRegistered':
      return ev('agent', `Agent registered at ${tier(a.tier)}, bond ${amt(a.bond)}, operator ${shortAddr(a.operator)}`);
    case 'OperatorRotated':
      return ev('agent', `Operator rotated ${shortAddr(a.from)} → ${shortAddr(a.to)}`);
    case 'ActiveSet':
      return ev('agent', a.active ? 'Agent resumed' : 'Agent paused');
    case 'TierDemonstrated':
      return ev('agent', `First ${tier(a.tier)} delivery`);
    case 'BondIncreased':
      return ev('bond', `Bond +${amt(a.amount)}, now ${amt(a.total)}`);
    case 'UnbondingStarted':
      return ev('bond', `Unbonding ${amt(a.amount)}, available ${until(a.availableAt)}`);
    case 'Withdrawn':
      return ev('bond', `Withdrew ${amt(a.amount)}`);
    case 'WithdrawnEarly':
      return ev('bond', `Withdrew early: ${amt(a.paid)} paid out, ${amt(a.penalty)} penalty`);
    case 'Slashed':
      return ev('fault', `Bond slashed ${amt(a.amount)}, bounty to ${shortAddr(a.recipient)}`);
    case 'ExposureChanged':
      return ev('bond', `Open notional now ${amt(a.openNotional)}`);

    // Reputation.
    case 'AgentInitialized':
      return ev('reputation', `Score initialised at ${a.score}`);
    case 'OutcomeRecorded':
      return ev('reputation', `Outcome recorded, quality ${a.quality}; score now ${a.newScore}`);
    case 'FaultRecorded':
      return ev('reputation', `Fault recorded; score now ${a.newScore}, ${a.faults} fault(s)`);
    case 'VoiceEarned':
      return ev('reputation', `Consumer ${shortAddr(a.consumer)} earned reputation weight`);

    // Attestation and adapters.
    case 'PublisherSet':
      return ev('admin', `Publisher ${shortAddr(a.publisher)} ${a.allowed ? 'added' : 'removed'}`);
    case 'QuorumSet':
      return ev('admin', `Quorum set to ${a.quorum}`);
    case 'WorkAttributed':
      return ev('reputation', 'Gold proof attributed to this agent');
    case 'VerifierSet':
      return ev('admin', `Gold verifier set to ${shortAddr(a.verifier)}`);
  }

  // Everything else is wiring: ownership, timelock queues, parameter changes. Rendered from its
  // own fields so a new event shows up rather than vanishing.
  const fields = Object.entries(a)
    .filter(([k]) => !/^\d+$/.test(k))
    .map(([k, v]) => `${k} ${typeof v === 'string' && v.startsWith('0x') ? shortAddr(v) : String(v)}`)
    .join(', ');
  return ev('admin', fields ? `${name}: ${fields}` : name);
}

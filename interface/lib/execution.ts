// One request, read whole.
//
// `lib/activity.ts` folds the router's logs into rows for a table; this file does the opposite
// errand — everything knowable about a single requestId, for the two pages that are a record of one
// execution rather than a list of many.
//
// Three sources, in descending order of authority:
//
//   1. `getRequest` — the router's own storage. The status, the commitments, the money. Whatever
//      this says is what the contract will act on, so it is the spine of both pages.
//   2. The lifecycle logs for that id — when each stage happened, and in which transaction. Storage
//      knows where a request got to; only the logs know when, and a receipt without dates is not
//      much of a receipt.
//   3. The delivery transaction's calldata — the input bundle and the attestation. Neither is
//      stored on chain: `deliver` verifies them and keeps only the commitment, so the only place
//      the evidence still exists is the transaction that carried it. This is the part that can
//      legitimately be missing, and every caller has to handle that.
//
// No 'use client'. Both pages that use this are server components, and the whole reason they are
// server components is that a receipt has to be in the HTML before JavaScript runs.

import { decodeAbiParameters, decodeFunctionData, parseAbiParameters } from 'viem';
import { executionRouterAbi } from '@abi/ExecutionRouter';
import { addressOf } from './contracts';
import { publicClient } from './chain';
import { tierNameOf, type TierName } from './registry';
import { routerLogs, blockTimes, type Verb } from './activity';
import type { NetworkId } from './network';

/** Types.sol, transcribed whole — including None, whose omission would shift every name left. */
export const STATUS_NAMES = [
  'None', 'Pending', 'Delivered', 'Challenged', 'Finalized', 'Settled', 'Expired', 'Faulted',
] as const;
export type RequestStatus = (typeof STATUS_NAMES)[number];

export interface RequestRecord {
  requestId: `0x${string}`;
  consumer: `0x${string}`;
  agentId: bigint;
  inputCommitment: `0x${string}`;
  /** Zero until delivery. The router writes it in `deliver`, so it doubles as "has it arrived". */
  outputCommitment: `0x${string}`;
  notional: bigint;
  fee: bigint;
  /** Seconds, as the chain stores them. Callers multiply where they want milliseconds. */
  createdAt: bigint;
  deliverBy: bigint;
  finalizeAt: bigint;
  settleBy: bigint;
  tier: number;
  tierName: TierName | undefined;
  status: RequestStatus;
  challenger: `0x${string}`;
  challengeBond: bigint;
  escalationDeadline: bigint;
}

/**
 * The router's record for one request, or undefined if it has none.
 *
 * `getRequest` does not revert on an id that was never issued — it returns a zero-filled struct,
 * the same way `getAgent` does — so absence has to be detected rather than caught. Status `None` is
 * the marker: every real request is at least Pending, and no lifecycle transition ever returns to
 * zero, so a zero status means the router has never heard of this id.
 */
export async function readRequest(network: NetworkId, requestId: string): Promise<RequestRecord | undefined> {
  const router = addressOf(network, 'ExecutionRouter');
  if (!router || !/^0x[0-9a-fA-F]{64}$/.test(requestId)) return undefined;

  const r = await publicClient(network).readContract({
    address: router,
    abi: executionRouterAbi,
    functionName: 'getRequest',
    args: [requestId as `0x${string}`],
  });

  const status = STATUS_NAMES[Number(r.status)] ?? 'None';
  if (status === 'None') return undefined;

  return {
    requestId: requestId as `0x${string}`,
    consumer: r.consumer,
    agentId: r.agentId,
    inputCommitment: r.inputCommitment,
    outputCommitment: r.outputCommitment,
    notional: r.notional,
    fee: r.fee,
    createdAt: r.createdAt,
    deliverBy: r.deliverBy,
    finalizeAt: r.finalizeAt,
    settleBy: r.settleBy,
    tier: Number(r.tier),
    // Tier is zero on a request that has not been delivered yet: it is the tier the delivery was
    // made at, not one the consumer asked for. Undefined rather than a label, so a page renders
    // "not yet delivered" instead of confidently naming a tier nobody has claimed.
    tierName: Number(r.tier) > 0 ? tierNameOf(Number(r.tier)) : undefined,
    status,
    challenger: r.challenger,
    challengeBond: r.challengeBond,
    escalationDeadline: r.escalationDeadline,
  };
}

export interface Step {
  verb: Verb;
  block: bigint;
  /** Milliseconds, 0 where the block could not be dated. */
  time: number;
  txHash: `0x${string}`;
  detail?: string;
}

/**
 * The lifecycle of one request, oldest first.
 *
 * A timeline, unlike the feed, is read in the order things happened — a receipt is an argument that
 * proceeds forwards, where a feed is a question about what just changed.
 */
export async function readRequestSteps(network: NetworkId, requestId: string): Promise<Step[]> {
  const router = addressOf(network, 'ExecutionRouter');
  if (!router) return [];

  const client = publicClient(network);
  const head = await client.getBlockNumber();
  const logs = await routerLogs(network, head);

  const id = requestId.toLowerCase();
  const steps: Step[] = [];
  for (const log of logs) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const args = (log as any).args ?? {};
    if (typeof args.requestId !== 'string' || args.requestId.toLowerCase() !== id) continue;
    const verb = STEP_VERB[log.eventName as keyof typeof STEP_VERB];
    if (!verb) continue;
    steps.push({
      verb,
      block: log.blockNumber,
      time: 0,
      txHash: log.transactionHash,
      detail: STEP_DETAIL[log.eventName as keyof typeof STEP_DETAIL]?.(args),
    });
  }

  steps.sort((a, b) => (a.block === b.block ? 0 : a.block > b.block ? 1 : -1));
  const times = await blockTimes(network, steps.map((s) => s.block));
  for (const s of steps) s.time = times.get(s.block) ?? 0;
  return steps;
}

const STEP_VERB = {
  ExecutionRequested: 'REQUEST',
  ExecutionDelivered: 'DELIVER',
  ExecutionChallenged: 'CHALLENGE',
  ChallengeResolved: 'RESOLVE',
  ExecutionFinalized: 'FINAL',
  ExecutionSettled: 'SETTLE',
  ExecutionExpired: 'EXPIRE',
  ExecutionFaulted: 'SLASH',
} as const satisfies Record<string, Verb>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const STEP_DETAIL: Record<string, (a: any) => string | undefined> = {
  ExecutionRequested: (a) => (a.inputURI ? String(a.inputURI) : undefined),
  ExecutionDelivered: (a) => `tier ${tierNameOf(Number(a.tier))}`,
  ExecutionChallenged: (a) => `challenger ${a.challenger}`,
  ExecutionSettled: (a) => `${Number(a.realizedPnlBps) >= 0 ? '+' : ''}${Number(a.realizedPnlBps)} bps`,
};

/** One reading in the attested input bundle. The value is committed to, never carried. */
export interface Feed {
  feedId: `0x${string}`;
  valueHash: `0x${string}`;
  /** Seconds. */
  timestamp: bigint;
  signatures: number;
}

/** A Gold opening: the publisher-signed reading, with the number behind the hash. */
export interface Reveal {
  feedId: `0x${string}`;
  timestamp: bigint;
  value: bigint;
  salt: `0x${string}`;
}

export interface Delivery {
  txHash: `0x${string}`;
  outputCommitment: `0x${string}`;
  /** Undefined where the bundle did not decode — see the note on readDelivery. */
  feeds?: Feed[];
  /**
   * Gold only. The proof bytes, the instance vector, and the openings that bind it to the inputs —
   * plus the raw attestation they were decoded out of, because re-verification is `verify(ctx,
   * attestation)` and re-encoding the parts would be a second implementation of the encoding, able
   * to disagree with the bytes the adapter actually accepted.
   */
  proof?: { bytes: `0x${string}`; instances: readonly bigint[]; reveals: Reveal[]; attestation: `0x${string}` };
  /** Length of the raw attestation blob, which is all we can say about a Bronze or Silver one. */
  attestationBytes: number;
}

/** Mirrors relayer/src/digest.js: the bundle and the Gold attestation, byte for byte. */
const BUNDLE_TYPE = parseAbiParameters('(bytes32,bytes32,uint64,bytes[])[]');
const ZK_ATTESTATION_TYPE = parseAbiParameters('bytes, uint256[], (bytes32,uint64,int256,bytes32)[]');

/**
 * The evidence, recovered from the delivery transaction.
 *
 * `deliver` verifies the bundle and the attestation and then stores neither — it keeps the output
 * commitment and throws the arguments away, which is the right trade on gas and means this is the
 * only place the evidence survives. So the page reads calldata: find the ExecutionDelivered log,
 * fetch the transaction it came from, and decode the arguments the operator actually passed.
 *
 * Every step of that can legitimately fail. An operator delivering through a multisig or a batcher
 * produces a transaction whose calldata is that contract's function, not `deliver`, and no amount
 * of care here will decode it. That is a gap in what this page can show, not a fault in the
 * delivery — so it returns undefined and the page says the evidence is not in this transaction,
 * rather than pretending the delivery never happened.
 */
export async function readDelivery(network: NetworkId, requestId: string): Promise<Delivery | undefined> {
  const router = addressOf(network, 'ExecutionRouter');
  if (!router) return undefined;

  const client = publicClient(network);
  const head = await client.getBlockNumber();
  const logs = await routerLogs(network, head);
  const id = requestId.toLowerCase();
  const delivered = logs.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (l) => l.eventName === 'ExecutionDelivered' && String((l as any).args?.requestId).toLowerCase() === id
  );
  if (!delivered) return undefined;

  let tx;
  try {
    tx = await client.getTransaction({ hash: delivered.transactionHash });
  } catch {
    return undefined;
  }

  let args: readonly unknown[] | undefined;
  try {
    const decoded = decodeFunctionData({ abi: executionRouterAbi, data: tx.input });
    if (decoded.functionName === 'deliver') args = decoded.args as readonly unknown[];
  } catch {
    // Not a direct `deliver` call. Handled below by returning what the log alone can tell us.
  }

  const out: Delivery = {
    txHash: delivered.transactionHash,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    outputCommitment: (delivered as any).args.outputCommitment,
    attestationBytes: 0,
  };
  if (!args) return out;

  const bundle = args[2] as `0x${string}`;
  const attestation = args[3] as `0x${string}`;
  out.attestationBytes = Math.max(0, (attestation.length - 2) / 2);

  try {
    const [rows] = decodeAbiParameters(BUNDLE_TYPE, bundle);
    out.feeds = (rows as readonly [`0x${string}`, `0x${string}`, bigint, readonly unknown[]][]).map((r) => ({
      feedId: r[0],
      valueHash: r[1],
      timestamp: r[2],
      signatures: r[3].length,
    }));
  } catch {
    // Left undefined. A bundle that does not decode is worth saying nothing about rather than
    // guessing at — the commitment on chain is the thing that was actually checked.
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tier = Number((delivered as any).args.tier);
  if (tier === 3) {
    try {
      const [bytes, instances, reveals] = decodeAbiParameters(ZK_ATTESTATION_TYPE, attestation);
      out.proof = {
        bytes: bytes as `0x${string}`,
        attestation,
        instances: instances as readonly bigint[],
        reveals: (reveals as readonly [`0x${string}`, bigint, bigint, `0x${string}`][]).map((r) => ({
          feedId: r[0],
          timestamp: r[1],
          value: r[2],
          salt: r[3],
        })),
      };
    } catch {
      // A Gold delivery whose attestation does not decode to this shape did not come from this
      // repo's relayer. The adapter accepted it, so it is valid; we just cannot read it out.
    }
  }

  return out;
}

/** The adapter that verified a tier, for the "who checked this" line on both pages. */
export async function readAdapter(network: NetworkId, tier: number): Promise<`0x${string}` | undefined> {
  const router = addressOf(network, 'ExecutionRouter');
  if (!router || tier <= 0) return undefined;
  try {
    const address = await publicClient(network).readContract({
      address: router,
      abi: executionRouterAbi,
      functionName: 'adapters',
      args: [tier],
    });
    return address === '0x0000000000000000000000000000000000000000' ? undefined : address;
  } catch {
    return undefined;
  }
}

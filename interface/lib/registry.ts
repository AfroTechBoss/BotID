// Typed reads against AgentRegistry, and the ERC-20 dance in front of them.
//
// Everything returns base-unit bigints and is handed straight to lib/token.ts for display. No
// number conversion happens in this file, on purpose — see the header of token.ts.

import { erc20Abi, type Address, type PublicClient } from 'viem';
import { agentRegistryAbi } from '@abi/AgentRegistry';
import { addressOf, DEPLOY_BLOCK } from './contracts';
import { publicClient, logWindows } from './chain';
import type { NetworkId } from './network';

/** Mirrors the contract's `Tier` enum, where 0 is None and registering with it reverts. */
export const TIER_VALUE = { bronze: 1, silver: 2, gold: 3 } as const;
export type TierName = keyof typeof TIER_VALUE;

/**
 * The enum read back the other way, for display.
 *
 * 0 is None and is unreachable for anything that got as far as being registered — the contract
 * reverts on it — so the fallback is a formality rather than a case worth rendering. It resolves to
 * bronze because the alternative, an agent that vanishes from a leaderboard because its tier byte
 * was unexpected, hides a fact rather than reporting one.
 */
export function tierNameOf(tier: number): TierName {
  return tier === 3 ? 'gold' : tier === 2 ? 'silver' : 'bronze';
}

export interface AgentView {
  agentId: bigint;
  owner: Address;
  operator: Address;
  modelCommitment: `0x${string}`;
  tier: number;
  active: boolean;
  lossToleranceBps: number;
  bond: bigint;
  openNotional: bigint;
  unbondingAmount: bigint;
  unbondingAt: bigint;
  /** From previewWithdrawEarly — the contract's own answer, never recomputed here. */
  earlyExit: { allowed: boolean; paid: bigint; penalty: bigint };
  maxOpenNotional: bigint;
  score: number;
  faults: number;
  settledExecutions: number;
  lastActiveAt: bigint;
}

/** Registry address for a network, or undefined where the protocol is not deployed. */
export function registryAddress(network: NetworkId) {
  return addressOf(network, 'AgentRegistry');
}

/**
 * Agent ids owned by `owner`, found by log rather than by index.
 *
 * There is no enumeration on the contract — `_nextAgentId` is private and there is no
 * `agentsOf(address)`. `owner` is an indexed topic on AgentRegistered though, so the log filter
 * does the work the missing view would have done, and the RPC does the filtering rather than us
 * pulling every registration and discarding most of it.
 *
 * This is the one read here that an indexer would eventually own. It is fine directly against RPC
 * while the deployment is days old; it stops being fine when `DEPLOY_BLOCK` is far enough behind
 * the head that the node refuses the range.
 */
export async function agentIdsOf(network: NetworkId, owner: Address): Promise<bigint[]> {
  return registeredIds(network, owner);
}

/**
 * Every agent id ever registered, in creation order. The leaderboard's source.
 *
 * The same query as `agentIdsOf` with the topic filter taken off, which is the whole difference
 * between "my agents" and "all agents" — `owner` is indexed, so leaving it out is asking the node
 * for the unfiltered set rather than fetching everything and discarding. There is no deregistration
 * event, so every id here is still an id; whether the agent is *active* is a field on the agent,
 * read separately.
 */
export async function allAgentIds(network: NetworkId): Promise<bigint[]> {
  return registeredIds(network);
}

const AGENT_REGISTERED = {
  type: 'event',
  name: 'AgentRegistered',
  inputs: [
    { name: 'agentId', type: 'uint256', indexed: true },
    { name: 'owner', type: 'address', indexed: true },
    { name: 'operator', type: 'address', indexed: true },
    { name: 'tier', type: 'uint8', indexed: false },
    { name: 'modelCommitment', type: 'bytes32', indexed: false },
    { name: 'bond', type: 'uint256', indexed: false },
  ],
} as const;

async function registeredIds(network: NetworkId, owner?: Address): Promise<bigint[]> {
  const registry = registryAddress(network);
  const fromBlock = DEPLOY_BLOCK[network];
  if (!registry || fromBlock === undefined) return [];
  const client = publicClient(network);

  // Windowed rather than fromBlock..'latest'. A node that refuses the range answers with an error,
  // not with a short list, so an unwindowed query is a page that works until the deployment is old
  // enough and then fails outright. The head is pinned once here so every window is measured
  // against the same chain tip.
  const head = await client.getBlockNumber();
  const pages = await Promise.all(
    logWindows(fromBlock, head).map((range) =>
      client.getLogs({ address: registry, event: AGENT_REGISTERED, args: owner ? { owner } : {}, ...range })
    )
  );

  // Deduped and sorted: a reorg can deliver the same log twice, and ids should read in the order
  // they were created rather than the order the node happened to return them.
  const ids = [...new Set(pages.flat().map((l) => l.args.agentId as bigint))];
  return ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Every registered agent, resolved. What the leaderboard and the overview both render.
 *
 * Three contract reads per agent, sequential inside `readAgent` and parallel across agents. That is
 * the honest cost of having no enumeration view and no indexer: a hundred agents is three hundred
 * calls, which is the point at which this function stops being viable and the answer is a subgraph
 * rather than a cleverer loop. It is fine at the current count, which is small.
 *
 * An id whose read fails is dropped rather than rendered half-empty — a row of zeroes on a
 * leaderboard reads as a fact about the agent instead of as a failed request.
 */
export async function readAllAgents(network: NetworkId): Promise<AgentView[]> {
  const ids = await allAgentIds(network);
  const rows = await Promise.all(ids.map((id) => readAgent(network, id).catch(() => undefined)));
  return rows.filter((a): a is AgentView => a !== undefined);
}

/** Everything the portal shows about one agent, in one round of reads. */
export async function readAgent(network: NetworkId, agentId: bigint): Promise<AgentView | undefined> {
  const registry = registryAddress(network);
  if (!registry) return undefined;
  const client = publicClient(network);
  const contract = { address: registry, abi: agentRegistryAbi } as const;

  // Two reads, not four. getProfile already carries the credit line, the score and the fault and
  // settlement counts — it calls the same private _maxOpenNotional the contract uses to gate
  // reservations, so asking it is asking the authority rather than reproducing the formula here.
  //
  // Awaited as a pair rather than destructured out of Promise.all: viem infers the return shape
  // per call from the ABI, and Promise.all collapses four different shapes into their union, which
  // then needs casting back apart. Casting would defeat the point of the typed ABI.
  const agent = await client.readContract({ ...contract, functionName: 'getAgent', args: [agentId] });

  // An id that was never issued does not revert — Solidity hands back a zero-filled struct, and a
  // mapping has no opinion about which of its keys are real. Read literally that is a Bronze agent
  // owned by the zero address with a zero bond and a zero commitment, which is a plausible-looking
  // agent that does not exist. Registration always sets owner to msg.sender, so a zero owner is the
  // one field that distinguishes "absent" from "empty", and every caller wants absent.
  if (agent.owner === '0x0000000000000000000000000000000000000000') return undefined;

  const profile = await client.readContract({ ...contract, functionName: 'getProfile', args: [agentId] });
  const earlyExit = await client.readContract({ ...contract, functionName: 'previewWithdrawEarly', args: [agentId] });

  return {
    agentId,
    owner: agent.owner,
    operator: agent.operator,
    modelCommitment: agent.modelCommitment,
    tier: Number(agent.tier),
    active: agent.active,
    lossToleranceBps: Number(agent.lossToleranceBps),
    bond: agent.bond,
    openNotional: agent.openNotional,
    unbondingAmount: agent.unbondingAmount,
    unbondingAt: BigInt(agent.unbondingAt),
    earlyExit: { allowed: earlyExit[0], paid: earlyExit[1], penalty: earlyExit[2] },
    maxOpenNotional: profile.maxOpenNotional,
    score: Number(profile.score),
    faults: Number(profile.faults),
    settledExecutions: Number(profile.settledExecutions),
    lastActiveAt: BigInt(profile.lastActiveAt),
  };
}

/** The protocol-wide limits the portal quotes. Read, never hardcoded — they are owner-settable. */
export async function readLimits(network: NetworkId) {
  const registry = registryAddress(network);
  if (!registry) return undefined;
  const client = publicClient(network);
  const contract = { address: registry, abi: agentRegistryAbi } as const;

  const [minBond, globalNotionalCap, earlyExitPenaltyBps] = await Promise.all([
    client.readContract({ ...contract, functionName: 'minBond' }),
    client.readContract({ ...contract, functionName: 'globalNotionalCap' }),
    client.readContract({ ...contract, functionName: 'earlyExitPenaltyBps' }),
  ]);
  return { minBond, globalNotionalCap, earlyExitPenaltyBps: Number(earlyExitPenaltyBps) };
}

/**
 * Bond-token balance, allowance and decimals for `owner`.
 *
 * decimals() is read rather than taken from lib/token.ts. That constant is a display default and
 * the comment on it says as much; here the number decides how a user's typed "100" is scaled into
 * a transaction, and being wrong by 10^12 is the exact failure the deploy script guards against.
 * Read it from the token that is actually there.
 */
export async function readBondToken(network: NetworkId, owner: Address) {
  const token = addressOf(network, 'bondToken');
  const registry = registryAddress(network);
  if (!token || !registry) return undefined;
  const client: PublicClient = publicClient(network);
  const contract = { address: token, abi: erc20Abi } as const;

  const [balance, allowance, decimals, symbol] = await Promise.all([
    client.readContract({ ...contract, functionName: 'balanceOf', args: [owner] }),
    client.readContract({ ...contract, functionName: 'allowance', args: [owner, registry] }),
    client.readContract({ ...contract, functionName: 'decimals' }),
    client.readContract({ ...contract, functionName: 'symbol' }),
  ]);
  return { address: token, balance, allowance, decimals, symbol };
}

/**
 * keccak256 of a label, for the model commitment field.
 *
 * A convenience for the form and nothing more. A real model commitment is weightsHash ‖ vkHash ‖
 * declared limits, produced where the model is built — not typed into a web page. The form says so
 * next to the field; this exists so a testnet registration does not require the operator to go and
 * find a hashing tool.
 */
export { keccak256, toHex } from 'viem';

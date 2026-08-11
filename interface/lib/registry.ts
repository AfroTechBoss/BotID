// Typed reads against AgentRegistry, and the ERC-20 dance in front of them.
//
// Everything returns base-unit bigints and is handed straight to lib/token.ts for display. No
// number conversion happens in this file, on purpose — see the header of token.ts.

import { erc20Abi, type Address, type PublicClient } from 'viem';
import { agentRegistryAbi } from '@abi/AgentRegistry';
import { addressOf, DEPLOY_BLOCK } from './contracts';
import { publicClient } from './chain';
import type { NetworkId } from './network';

/** Mirrors the contract's `Tier` enum, where 0 is None and registering with it reverts. */
export const TIER_VALUE = { bronze: 1, silver: 2, gold: 3 } as const;
export type TierName = keyof typeof TIER_VALUE;

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
  const registry = registryAddress(network);
  const fromBlock = DEPLOY_BLOCK[network];
  if (!registry || fromBlock === undefined) return [];

  const logs = await publicClient(network).getLogs({
    address: registry,
    event: {
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
    },
    args: { owner },
    fromBlock,
    toBlock: 'latest',
  });

  // Deduped and sorted: a reorg can deliver the same log twice, and ids should read in the order
  // they were created rather than the order the node happened to return them.
  const ids = [...new Set(logs.map((l) => l.args.agentId as bigint))];
  return ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
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

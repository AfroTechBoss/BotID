// GET /api/agents/:id/policy — does this agent clear a hiring policy?
//
//   curl 'https://…/api/agents/1/policy?minScore=8500&minTier=silver&maxFaults=0'
//
// The verdict comes from `meetsPolicy` on the registry — the same function a vault calls in
// Solidity — so an off-chain screen and an on-chain gate cannot disagree about who was eligible.
// The per-criterion breakdown alongside it is computed here, and is explanation rather than
// authority: `meetsPolicy` returns a bare boolean, and "no" without "why" is a closed door with
// no sign on it.

import { agentRegistryAbi } from '@abi/AgentRegistry';
import { publicClient } from '@/lib/chain';
import { readAgent, registryAddress, TIER_VALUE, tierNameOf, type TierName } from '@/lib/registry';
import { fail, json, parseAgentId, parseNetwork, preflight } from '../../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function OPTIONS() {
  return preflight();
}

/** A query parameter as a bigint, or an error describing which one was malformed. */
function num(url: URL, key: string, fallback: bigint): bigint | { bad: string } {
  const raw = url.searchParams.get(key);
  if (raw === null || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) return { bad: raw };
  return BigInt(raw);
}

export async function GET(req: Request, ctx: { params: { id: string } }) {
  const url = new URL(req.url);
  const net = parseNetwork(url);
  if ('error' in net) return net.error;
  const { network } = net;

  const agentId = parseAgentId(ctx.params.id);
  if (agentId === undefined) {
    return fail(400, 'agent id must be a positive integer', { given: ctx.params.id });
  }

  const registry = registryAddress(network);
  if (!registry) return fail(404, 'BotID is not deployed on this network', { network });

  // Defaults are the permissive value, so an omitted criterion is not a criterion. The exception
  // is maxFaults: its permissive default is infinity, and someone who did not think about faults
  // is not asking for an agent that has committed one.
  const tierRaw = (url.searchParams.get('minTier') ?? '').toLowerCase();
  if (tierRaw && !(tierRaw in TIER_VALUE)) {
    return fail(400, 'unknown minTier', { given: tierRaw, known: Object.keys(TIER_VALUE) });
  }
  const minTier = tierRaw ? TIER_VALUE[tierRaw as TierName] : 0;

  const parsed = {
    minScore: num(url, 'minScore', 0n),
    maxFaults: num(url, 'maxFaults', 0n),
    minBond: num(url, 'minBond', 0n),
    maxStalenessSeconds: num(url, 'maxStalenessSeconds', 0n),
  };
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'object') {
      return fail(400, `${key} must be a non-negative integer`, { given: value.bad });
    }
  }
  const policy = parsed as Record<keyof typeof parsed, bigint>;

  let eligible: boolean;
  let agent;
  try {
    // Issued together. The verdict is the answer; the agent record is only needed to explain it,
    // and making the caller wait for two sequential round trips to get one answer is the latency
    // pattern the interface already paid to remove.
    [eligible, agent] = await Promise.all([
      publicClient(network).readContract({
        address: registry,
        abi: agentRegistryAbi,
        functionName: 'meetsPolicy',
        args: [
          agentId,
          {
            minScore: Number(policy.minScore),
            minTier,
            maxFaults: Number(policy.maxFaults),
            minBond: policy.minBond,
            maxStalenessSeconds: policy.maxStalenessSeconds,
          },
        ],
      }),
      readAgent(network, agentId),
    ]);
  } catch (e) {
    return fail(502, 'could not read the registry', {
      network,
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  if (!agent) return fail(404, 'no such agent', { network, agentId });

  // Recomputed from the same fields the contract reads, in the same order. If one of these ever
  // disagrees with `eligible`, believe `eligible` — it is the chain's answer and this is a
  // courtesy. The mismatch would itself be worth knowing about, so it is reported rather than
  // hidden.
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  const staleness = nowSeconds - agent.lastActiveAt;
  const checks = {
    active: agent.active,
    tier: agent.tier >= minTier,
    bond: agent.bond >= policy.minBond,
    score: BigInt(agent.score) >= policy.minScore,
    faults: BigInt(agent.faults) <= policy.maxFaults,
    fresh: policy.maxStalenessSeconds === 0n || staleness <= policy.maxStalenessSeconds,
  };
  const failed = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);

  return json({
    network,
    agentId,
    eligible,
    // Named so the caller knows which of the two numbers is load-bearing.
    verdictSource: 'AgentRegistry.meetsPolicy',
    failedCriteria: failed,
    explanationDisagrees: eligible === (failed.length > 0) ? true : undefined,
    policy: {
      minScore: policy.minScore,
      minTier: { value: minTier, name: minTier ? tierNameOf(minTier) : null },
      maxFaults: policy.maxFaults,
      minBond: policy.minBond,
      maxStalenessSeconds: policy.maxStalenessSeconds,
    },
    agent: {
      active: agent.active,
      tier: { value: agent.tier, name: tierNameOf(agent.tier) },
      bond: agent.bond,
      score: agent.score,
      faults: agent.faults,
      settledExecutions: agent.settledExecutions,
      lastActiveAt: agent.lastActiveAt,
      secondsSinceActive: staleness,
    },
  });
}

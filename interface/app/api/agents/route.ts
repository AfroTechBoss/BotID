// GET /api/agents — every registered agent, best first.
//
//   curl 'https://…/api/agents?minTier=silver&limit=10'
//
// The leaderboard, as data. This is the closest thing the protocol has to a discovery surface:
// there is no enumeration view on the contract and no indexer, so the set is recovered from
// AgentRegistered logs and each row costs reads. Fine at the current count and explicitly not
// fine at a hundred agents — see readAllAgents, which says where the ceiling is.

import { readAllAgents, registryAddress, TIER_VALUE, tierNameOf, type TierName } from '@/lib/registry';
import { fail, json, parseNetwork, preflight } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function OPTIONS() {
  return preflight();
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const net = parseNetwork(url);
  if ('error' in net) return net.error;
  const { network } = net;

  if (!registryAddress(network)) {
    return fail(404, 'BotID is not deployed on this network', { network });
  }

  const tierRaw = (url.searchParams.get('minTier') ?? '').toLowerCase();
  if (tierRaw && !(tierRaw in TIER_VALUE)) {
    return fail(400, 'unknown minTier', { given: tierRaw, known: Object.keys(TIER_VALUE) });
  }
  const minTier = tierRaw ? TIER_VALUE[tierRaw as TierName] : 0;

  const limitRaw = url.searchParams.get('limit');
  if (limitRaw !== null && !/^\d+$/.test(limitRaw)) {
    return fail(400, 'limit must be a non-negative integer', { given: limitRaw });
  }
  const limit = Math.min(limitRaw ? Number(limitRaw) : 100, 200);

  let agents;
  try {
    agents = await readAllAgents(network);
  } catch (e) {
    return fail(502, 'could not read the registry', {
      network,
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  const activeOnly = url.searchParams.get('active') !== 'false';
  const rows = agents
    .filter((a) => (activeOnly ? a.active : true))
    .filter((a) => a.tier >= minTier)
    // Score first, then settled work as the tie-break. A fresh agent and a proven one both sit at
    // the starting score, and ordering them arbitrarily would put an untested agent above one
    // with a record for no reason a caller could see.
    .sort((a, b) => b.score - a.score || b.settledExecutions - a.settledExecutions)
    .slice(0, limit)
    .map((a) => ({
      agentId: a.agentId,
      operator: a.operator,
      tier: { value: a.tier, name: tierNameOf(a.tier) },
      active: a.active,
      bond: a.bond,
      openNotional: a.openNotional,
      maxOpenNotional: a.maxOpenNotional,
      score: a.score,
      faults: a.faults,
      settledExecutions: a.settledExecutions,
      lastActiveAt: a.lastActiveAt,
    }));

  return json({
    network,
    // `count` is what came back after filtering; `total` is what is registered. A caller that
    // sees 3 of 40 knows its filter did that, rather than concluding the protocol is empty.
    count: rows.length,
    total: agents.length,
    agents: rows,
  });
}

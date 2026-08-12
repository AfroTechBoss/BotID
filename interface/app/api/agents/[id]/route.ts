// GET /api/agents/:id — everything on the record for one agent.
//
//   curl https://…/api/agents/1
//   curl https://…/api/agents/1?network=testnet

import { readAgent, registryAddress, tierNameOf } from '@/lib/registry';
import { fail, json, parseAgentId, parseNetwork, preflight } from '../../_shared';

export const runtime = 'nodejs';
// Chain state, so nothing here can be baked at build time. Freshness is managed by the
// cache-control header instead, where a caller can see it.
export const dynamic = 'force-dynamic';

export function OPTIONS() {
  return preflight();
}

export async function GET(_req: Request, ctx: { params: { id: string } }) {
  const url = new URL(_req.url);
  const net = parseNetwork(url);
  if ('error' in net) return net.error;
  const { network } = net;

  const agentId = parseAgentId(ctx.params.id);
  if (agentId === undefined) {
    return fail(400, 'agent id must be a positive integer', { given: ctx.params.id });
  }

  // Not deployed is a different answer from not found, and conflating them would tell a caller
  // their agent does not exist when the truth is that the protocol is not on this chain yet.
  if (!registryAddress(network)) {
    return fail(404, 'BotID is not deployed on this network', { network });
  }

  let agent;
  try {
    agent = await readAgent(network, agentId);
  } catch (e) {
    // The RPC failing is our problem, not the caller's, and it is temporary. Saying so with a 502
    // rather than a 404 is the difference between a client that retries and one that gives up and
    // records the agent as nonexistent.
    return fail(502, 'could not read the registry', {
      network,
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  if (!agent) return fail(404, 'no such agent', { network, agentId });

  return json({
    network,
    agentId: agent.agentId,
    owner: agent.owner,
    operator: agent.operator,
    tier: { value: agent.tier, name: tierNameOf(agent.tier) },
    active: agent.active,
    modelCommitment: agent.modelCommitment,
    // Base units, as strings. The bond token's own decimals() governs the scale — it is not
    // assumed here, and a caller that needs to display these should read it too.
    bond: agent.bond,
    openNotional: agent.openNotional,
    maxOpenNotional: agent.maxOpenNotional,
    lossToleranceBps: agent.lossToleranceBps,
    unbonding: { amount: agent.unbondingAmount, at: agent.unbondingAt },
    reputation: {
      score: agent.score,
      faults: agent.faults,
      settledExecutions: agent.settledExecutions,
      // Seconds, as the chain stores it. Converting to milliseconds here would make this
      // disagree with the same field read directly from the contract.
      lastActiveAt: agent.lastActiveAt,
    },
  });
}

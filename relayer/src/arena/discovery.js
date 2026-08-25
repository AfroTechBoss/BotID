const config = require("../config");
const { log } = require("../util");

/**
 * Who is there to hire.
 *
 * There is no enumeration on `AgentRegistry` — `_nextAgentId` is private and there is no
 * `agentsOf` — so the answer comes from the log rather than from a view. `interface/lib/registry.ts`
 * already does exactly this for the leaderboard and this is the same query in the relayer's
 * runtime; the two are siblings and a change to one is a question about the other.
 *
 * The windowing is not an optimisation. A node that will not serve a range that wide answers
 * with an error rather than a short list, so an unwindowed query is code that works right up
 * until the deployment is old enough and then stops — a filing cabinet that refuses to open
 * once it has enough in it, rather than one that hands you the first drawer.
 */
function windows(fromBlock, head, size = config.arena.logWindow) {
  const out = [];
  for (let start = fromBlock; start <= head; start += size) {
    out.push([start, Math.min(start + size - 1, head)]);
  }
  return out;
}

/**
 * Every agent id ever registered, in creation order.
 *
 * There is no deregistration event, so every id this returns is still an id. Whether the agent
 * is *active* is a field on the agent and is read separately — see `eligible` below.
 */
async function allAgentIds(contracts, provider, fromBlock) {
  const head = await provider.getBlockNumber();
  const start = fromBlock ?? config.arena.fromBlock ?? config.startBlock ?? Math.max(0, head - 50_000);

  const pages = await Promise.all(
    windows(start, head).map(([from, to]) =>
      contracts.registry
        .queryFilter(contracts.registry.filters.AgentRegistered(), from, to)
        .catch((e) => {
          // One refused window should not lose the other nineteen. It does need saying out
          // loud though: a silently short agent list looks identical to a quiet deployment.
          log.warn(`AgentRegistered ${from}-${to} failed: ${e.shortMessage ?? e.message}`);
          return [];
        })
    )
  );

  const ids = [...new Set(pages.flat().map((ev) => ev.args.agentId))];
  return ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Resolve each id into the fields the order loop decides on.
 *
 * `getProfile` is asked rather than recomputed: it carries the credit line, the score and the
 * fault count, and it derives `maxOpenNotional` with the same private helper the registry uses
 * to gate a reservation. Asking it is asking the authority. Recomputing the formula here would
 * be a fourth copy of something this codebase already keeps three of.
 */
async function readAgents(contracts, ids) {
  const rows = await Promise.all(
    ids.map(async (agentId) => {
      try {
        const [agent, profile] = await Promise.all([
          contracts.registry.getAgent(agentId),
          contracts.registry.getProfile(agentId),
        ]);
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
          maxOpenNotional: profile.maxOpenNotional,
          score: Number(profile.score),
          faults: Number(profile.faults),
          settledExecutions: Number(profile.settledExecutions),
        };
      } catch (e) {
        log.warn(`agent ${agentId} unreadable: ${e.shortMessage ?? e.message}`);
        return null;
      }
    })
  );
  return rows.filter(Boolean);
}

/**
 * The eligibility filter, and the reason each rejection happened.
 *
 * Reasons are returned rather than swallowed. "The Arena ordered nothing this pass" has half a
 * dozen causes that look identical from outside — nobody registered, everyone is mid-job,
 * everyone is still cooling down — and a loop that cannot tell you which is a loop nobody can
 * debug at three in the morning.
 */
function eligible(agents, { busy, lastOrdered, nowSec, cooldownSec, notionalBps }) {
  const picked = [];
  const skipped = [];

  for (const a of agents) {
    const id = String(a.agentId);
    const size = (BigInt(a.maxOpenNotional) * BigInt(notionalBps)) / 10_000n;
    const headroom = BigInt(a.maxOpenNotional) - BigInt(a.openNotional);

    if (!a.active) skipped.push({ agentId: id, why: "inactive" });
    else if (busy.has(id)) skipped.push({ agentId: id, why: "already has an open Arena job" });
    // `has` rather than a zero default: an agent the Arena has never ordered from has not just
    // been served, it has never been served, and those are opposite answers to "wait your turn".
    else if (lastOrdered.has(id) && nowSec - lastOrdered.get(id) < cooldownSec) {
      skipped.push({ agentId: id, why: "cooling down" });
    } else if (size <= 0n) skipped.push({ agentId: id, why: "credit line is zero" });
    else if (size > headroom) {
      skipped.push({ agentId: id, why: `needs ${size} of ${headroom} remaining credit` });
    } else picked.push({ ...a, notional: size });
  }

  // Longest-waiting first, so a quiet agent is not starved by whoever registered earliest.
  picked.sort((x, y) => (lastOrdered.get(String(x.agentId)) ?? 0) - (lastOrdered.get(String(y.agentId)) ?? 0));
  return { picked, skipped };
}

module.exports = { windows, allAgentIds, readAgents, eligible };

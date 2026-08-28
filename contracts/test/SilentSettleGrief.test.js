const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  E18,
  Tier,
  Status,
  now,
  increaseTime,
  signDigest,
  executionDigest,
  buildBundle,
  commitOutputs,
  deployProtocol,
  registerAgent,
} = require("./helpers");

const HOUR = 3600;
const DAY = 24 * HOUR;
const CLEAN = { realizedPnlBps: 0, slaBreached: false, limitBreached: false };

const OUTPUTS = [3300n, 6700n];
const OUT_COMMITMENT = commitOutputs(OUTPUTS);

/**
 * Regression suite for the silent-settle vector — buying reputation by not reporting.
 *
 * `settleDefault` exists so a consumer that goes quiet cannot hold an agent's exposure and fee
 * hostage forever. It settles "at par", which it implements by passing a zeroed `Outcome`. The
 * problem was that a zeroed Outcome is not neutral input: `ScoreMath.quality` starts at MAX_SCORE
 * and only ever subtracts, so no loss, no SLA breach and no limit breach reads as a flat 10,000 —
 * the best score the protocol can express. Fed in at full notional weight, the strongest positive
 * signal in the system was emitted precisely when nobody had said anything at all.
 *
 * That made reputation purchasable. An agent commissions its own work through an address it also
 * controls, delivers it, and then simply never settles. Seven days later anyone — including the
 * attacker — calls `settleDefault`, and the score goes up. The fee round-trips back to the same
 * party minus the protocol cut, so the running cost is `protocolFeeBps` of a fee the attacker
 * chose, and the reward is leverage: score drives `leverageBps` drives `maxOpenNotional`.
 *
 * The fix keeps the economics identical and records the observation at zero weight, which
 * `ScoreMath.observe` already treats as "leaves the score alone". These tests pin that the payout
 * path did not change, that the score no longer moves, and that reported outcomes still count.
 */
describe("silent-settle griefing — reputation for work nobody vouched for", function () {
  let env, agent;
  let feedNonce = 0;

  beforeEach(async function () {
    env = await deployProtocol();
    agent = await registerAgent(env, { tier: Tier.Bronze, bond: E18(1_000_000) });
  });

  /** Commission an execution as `caller`, who plays the consumer for this request. */
  async function commission(caller, agentId, opts = {}) {
    const ts = await now();
    const feeds = [
      {
        feedId: ethers.id("BOT/USD"),
        value: BigInt(12_500 + feedNonce),
        salt: ethers.id(`salt-${feedNonce++}`),
        timestamp: ts,
      },
    ];
    const { bundle, commitment } = buildBundle(env.chainId, env.attestor.target, feeds, [
      env.publisher,
    ]);
    const notional = opts.notional ?? E18(100_000);
    const fee = opts.fee ?? (notional * (await env.router.minFeeBps())) / 10_000n;

    const tx = await env.router
      .connect(caller)
      .requestExecution(agentId, commitment, notional, fee, ts + HOUR, "");
    const receipt = await tx.wait();
    const event = receipt.logs
      .map((l) => {
        try {
          return env.router.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e) => e && e.name === "ExecutionRequested");

    return { requestId: event.args.requestId, bundle, commitment, deliverBy: ts + HOUR };
  }

  async function deliverBronze(who, req) {
    const sig = signDigest(
      who.operator,
      executionDigest(env.chainId, env.sigAdapter.target, {
        requestId: req.requestId,
        agentId: who.agentId,
        modelCommitment: who.model,
        inputCommitment: req.commitment,
        outputCommitment: OUT_COMMITMENT,
        deliverBy: req.deliverBy,
      })
    );
    await env.router
      .connect(who.operator)
      .deliver(req.requestId, OUT_COMMITMENT, req.bundle, sig);
  }

  /** Carry one request from order to a lapsed settlement window, then default it. */
  async function runToDefault(caller, who, opts = {}) {
    const req = await commission(caller, who.agentId, opts);
    await deliverBronze(who, req);
    await increaseTime(2 * HOUR);
    await env.router.finalize(req.requestId);
    await increaseTime(8 * DAY);
    await env.router.connect(caller).settleDefault(req.requestId);
    return req;
  }

  describe("the score", function () {
    it("does not move — silence is not a five-star review", async function () {
      const before = await env.registry.getProfile(agent.agentId);
      await runToDefault(env.other, agent);

      const after = await env.registry.getProfile(agent.agentId);
      // Exactly neutral, not merely "not much higher". A fresh agent sits at NEUTRAL and decay
      // toward NEUTRAL is a no-op, so the only thing that could have moved this is the
      // observation — which is what the old code emitted at 10,000.
      expect(after.score).to.equal(5000);
      expect(after.score).to.equal(before.score);
    });

    it("cannot be topped up on an agent that already earned one", async function () {
      // The attack is most valuable to an agent with a real score to protect: a defaulted settle
      // used to be a free ratchet upward, one that no counterparty had to agree to.
      const first = await commission(env.consumer, agent.agentId, { notional: E18(400_000) });
      await deliverBronze(agent, first);
      await increaseTime(2 * HOUR);
      await env.router.finalize(first.requestId);
      await env.router.connect(env.consumer).settle(first.requestId, CLEAN);

      const earned = (await env.registry.getProfile(agent.agentId)).score;
      expect(earned).to.be.greaterThan(5000);

      await runToDefault(env.other, agent, { notional: E18(400_000) });

      // Decay pulls an above-neutral score back toward 5000 over the eight days this takes, so
      // the honest direction is downward. Anything above `earned` could only have come from the
      // placeholder outcome being scored as a perfect one.
      const after = (await env.registry.getProfile(agent.agentId)).score;
      expect(after).to.be.lessThanOrEqual(earned);
    });

    it("survives repetition — ten self-dealt rounds buy nothing at all", async function () {
      const before = await env.registry.getProfile(agent.agentId);
      // Attacker and agent owner are one party in the real attack; the fee moves between two of
      // its own pockets, so the only true cost is the protocol's cut of it.
      const attackerBefore = await env.token.balanceOf(env.other.address);
      const ownerBefore = await env.token.balanceOf(env.agentOwner.address);
      const treasuryBefore = await env.token.balanceOf(env.treasury.address);

      for (let i = 0; i < 10; i++) {
        await runToDefault(env.other, agent, { notional: E18(100_000), fee: E18(100) });
      }

      const after = await env.registry.getProfile(agent.agentId);
      expect(after.score).to.equal(before.score);
      // The credit line is the thing the score was being farmed *for*. It is where it started.
      expect(after.maxOpenNotional).to.equal(before.maxOpenNotional);
      expect(after.openNotional).to.equal(0);
      expect(after.faults).to.equal(0);

      // Ten rounds at a 100 fee: 5 to the treasury each time, 95 back to the other pocket.
      const attackerSpent = attackerBefore - (await env.token.balanceOf(env.other.address));
      const ownerGained = (await env.token.balanceOf(env.agentOwner.address)) - ownerBefore;
      expect(attackerSpent).to.equal(E18(1_000));
      expect(ownerGained).to.equal(E18(950));
      expect(await env.token.balanceOf(env.treasury.address)).to.equal(treasuryBefore + E18(50));
    });
  });

  describe("everything else about the default path", function () {
    it("still releases exposure and still pays the agent — silence is not a penalty either", async function () {
      const ownerBefore = await env.token.balanceOf(env.agentOwner.address);
      const treasuryBefore = await env.token.balanceOf(env.treasury.address);

      const req = await runToDefault(env.other, agent, { notional: E18(100_000), fee: E18(100) });

      expect((await env.router.getRequest(req.requestId)).status).to.equal(Status.Settled);
      expect((await env.registry.getProfile(agent.agentId)).openNotional).to.equal(0);
      expect(await env.token.balanceOf(env.agentOwner.address)).to.equal(ownerBefore + E18(95));
      expect(await env.token.balanceOf(env.treasury.address)).to.equal(treasuryBefore + E18(5));
    });

    it("still counts as activity — the work happened, it just says nothing about quality", async function () {
      await runToDefault(env.other, agent);

      const [, , settledExecutions, lastActiveAt] = await env.engine.getStats(agent.agentId);
      expect(settledExecutions).to.equal(1);
      expect(lastActiveAt).to.equal(BigInt(await now()));
    });

    it("is still open to anyone, and still refuses to run early", async function () {
      const req = await commission(env.consumer, agent.agentId);
      await deliverBronze(agent, req);
      await increaseTime(2 * HOUR);
      await env.router.finalize(req.requestId);

      await expect(env.router.settleDefault(req.requestId)).to.be.revertedWithCustomError(
        env.router,
        "DeadlineNotPassed"
      );

      await increaseTime(8 * DAY);
      // A stranger with no stake in either side — this is the watchtower's call, and it stays
      // permissionless. Removing the reward is what fixed the vector, not removing the caller.
      await env.router.connect(env.challenger).settleDefault(req.requestId);
      expect((await env.router.getRequest(req.requestId)).status).to.equal(Status.Settled);
    });
  });

  describe("reported outcomes", function () {
    it("still move the score, so the fix did not just switch scoring off", async function () {
      const req = await commission(env.consumer, agent.agentId, { notional: E18(400_000) });
      await deliverBronze(agent, req);
      await increaseTime(2 * HOUR);
      await env.router.finalize(req.requestId);
      await env.router.connect(env.consumer).settle(req.requestId, CLEAN);

      expect((await env.registry.getProfile(agent.agentId)).score).to.be.greaterThan(5000);
    });

    it("still carry a loss all the way down", async function () {
      const req = await commission(env.consumer, agent.agentId, { notional: E18(400_000) });
      await deliverBronze(agent, req);
      await increaseTime(2 * HOUR);
      await env.router.finalize(req.requestId);
      await env.router.connect(env.consumer).settle(req.requestId, {
        realizedPnlBps: -2_000,
        slaBreached: true,
        limitBreached: true,
      });

      expect((await env.registry.getProfile(agent.agentId)).score).to.be.lessThan(5000);
    });
  });
});

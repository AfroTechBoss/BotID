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
  revealsFor,
  commitOutputs,
  zkAttestation,
  SCALE_BITS,
  deployProtocol,
  registerAgent,
} = require("./helpers");

const HOUR = 3600;

const OUTPUTS = [3300n, 6700n];
const OUT_COMMITMENT = commitOutputs(OUTPUTS);

/**
 * Regression suite for the unanswerable-challenge vector.
 *
 * A Bronze delivery is only worth anything because anyone may challenge it and force the agent to
 * escalate to a Gold proof. That threat is what a bonded signature is really backed by. But the
 * threat only makes sense against an agent that *could* produce the proof, and whether it could is
 * not the agent's decision — `ZkAdapter.setVerifier` is owner-only, so an agent with no registered
 * circuit can never escalate, no matter how honest the delivery was.
 *
 * Against such an agent the old `challenge` was a paid weapon rather than a check. The sequence:
 * post `challengeBondAmount`, wait out `escalationWindow`, call `slashUnresolvedChallenge`. The
 * agent cannot answer, so it is slashed `faultSlashBps` of its bond, the challenger takes
 * `challengerBountyBps` of that and gets its own bond straight back, and a Verification fault
 * lands on a delivery nobody ever showed to be wrong. At the defaults that is 20% of the bond cut
 * and half of it paid to the attacker, per request, repeatable for as long as the agent keeps
 * trading — and the bond is never at risk, because it is only forfeited on the path where the
 * agent *does* resolve.
 *
 * The fix asks the Gold adapter whether the agent's model is verifiable at all before accepting a
 * challenge. It costs agents with a registered circuit nothing; it makes an agent without one
 * unchallengeable, which is honest, because a challenge against it never tested anything.
 */
describe("challenge griefing — the proof an agent was never able to give", function () {
  let env, agent;
  let feedNonce = 0;

  beforeEach(async function () {
    env = await deployProtocol();
    // Deliberately no `zkAdapter.setVerifier` for this model: this is an agent that registered,
    // bonded and delivers under Bronze, and has no circuit anyone could hold it to.
    agent = await registerAgent(env, { tier: Tier.Bronze, bond: E18(1_000_000) });
  });

  async function commission(agentId, opts = {}) {
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
      .connect(env.consumer)
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

    return {
      requestId: event.args.requestId,
      bundle,
      commitment,
      deliverBy: ts + HOUR,
      reveals: revealsFor(feeds),
    };
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
    await env.router.connect(who.operator).deliver(req.requestId, OUT_COMMITMENT, req.bundle, sig);
    return req;
  }

  /** Register a circuit for `model`, which is the only thing that makes it escalatable. */
  async function registerCircuit(model) {
    await env.zkAdapter.setVerifier(model, env.verifier.target, SCALE_BITS);
  }

  describe("canEscalate — the question challenge now asks first", function () {
    it("is false for an agent with no registered circuit, and true once it has one", async function () {
      expect(await env.router.canEscalate(agent.agentId)).to.equal(false);
      await registerCircuit(agent.model);
      expect(await env.router.canEscalate(agent.agentId)).to.equal(true);
    });

    it("goes back to false if the circuit is de-registered", async function () {
      await registerCircuit(agent.model);
      await env.zkAdapter.setVerifier(agent.model, ethers.ZeroAddress, SCALE_BITS);
      expect(await env.router.canEscalate(agent.agentId)).to.equal(false);
    });

    it("is false for every agent when no Gold adapter is set at all", async function () {
      await registerCircuit(agent.model);
      expect(await env.router.canEscalate(agent.agentId)).to.equal(true);

      // Nothing to escalate *to*, so nothing is escalatable — including an agent whose circuit
      // is registered at an adapter the router no longer consults.
      await env.router.setAdapter(Tier.Gold, ethers.ZeroAddress);
      expect(await env.router.canEscalate(agent.agentId)).to.equal(false);
    });
  });

  describe("the challenge that could only ever be won", function () {
    it("is refused outright", async function () {
      const req = await deliverBronze(agent, await commission(agent.agentId));
      await expect(
        env.router.connect(env.challenger).challenge(req.requestId)
      ).to.be.revertedWithCustomError(env.router, "NotEscalatable");
    });

    it("denies the griefer its payday — the whole chain, end to end", async function () {
      const before = await env.registry.getProfile(agent.agentId);
      const challengerBefore = await env.token.balanceOf(env.challenger.address);

      const req = await deliverBronze(agent, await commission(agent.agentId));
      await expect(
        env.router.connect(env.challenger).challenge(req.requestId)
      ).to.be.revertedWithCustomError(env.router, "NotEscalatable");

      // The follow-up the whole attack was for. There is no challenge to leave unresolved.
      await increaseTime(7 * HOUR);
      await expect(
        env.router.connect(env.challenger).slashUnresolvedChallenge(req.requestId)
      ).to.be.revertedWithCustomError(env.router, "BadStatus");

      const after = await env.registry.getProfile(agent.agentId);
      expect(after.bond).to.equal(before.bond);
      expect(after.faults).to.equal(0);
      expect(after.score).to.equal(before.score);
      expect(after.maxOpenNotional).to.equal(before.maxOpenNotional);
      // Not even the challenge bond moved — it is never collected, so there is nothing to refund.
      expect(await env.token.balanceOf(env.challenger.address)).to.equal(challengerBefore);
    });

    it("survives repetition — 20 attempts leave the agent exactly as it started", async function () {
      const before = await env.registry.getProfile(agent.agentId);
      const challengerBefore = await env.token.balanceOf(env.challenger.address);

      for (let i = 0; i < 20; i++) {
        const req = await deliverBronze(agent, await commission(agent.agentId, { notional: E18(1_000) }));
        await expect(
          env.router.connect(env.challenger).challenge(req.requestId)
        ).to.be.revertedWithCustomError(env.router, "NotEscalatable");
        await increaseTime(2 * HOUR);
        await env.router.finalize(req.requestId);
      }

      const after = await env.registry.getProfile(agent.agentId);
      expect(after.bond).to.equal(before.bond);
      expect(after.score).to.equal(before.score);
      expect(after.faults).to.equal(0);
      // Gas is the only thing the attack buys now.
      expect(await env.token.balanceOf(env.challenger.address)).to.equal(challengerBefore);
    });

    it("does not wedge the request — it finalizes and settles as if nobody had tried", async function () {
      const req = await deliverBronze(agent, await commission(agent.agentId, { fee: E18(100) }));
      await expect(
        env.router.connect(env.challenger).challenge(req.requestId)
      ).to.be.revertedWithCustomError(env.router, "NotEscalatable");

      const ownerBefore = await env.token.balanceOf(env.agentOwner.address);
      await increaseTime(2 * HOUR);
      await env.router.finalize(req.requestId);
      await env.router
        .connect(env.consumer)
        .settle(req.requestId, { realizedPnlBps: 0, slaBreached: false, limitBreached: false });

      expect((await env.router.getRequest(req.requestId)).status).to.equal(Status.Settled);
      expect((await env.registry.getProfile(agent.agentId)).openNotional).to.equal(0);
      expect(await env.token.balanceOf(env.agentOwner.address)).to.equal(ownerBefore + E18(95));
    });

    it("is decided when the challenge is raised, not when the delivery was made", async function () {
      // Escalatable at delivery, de-registered before anyone challenges. Reading live is what
      // makes this fail safe: the agent stops being challengeable rather than becoming free to
      // slash for a proof it can no longer produce.
      await registerCircuit(agent.model);
      const req = await deliverBronze(agent, await commission(agent.agentId));

      await env.zkAdapter.setVerifier(agent.model, ethers.ZeroAddress, SCALE_BITS);
      await expect(
        env.router.connect(env.challenger).challenge(req.requestId)
      ).to.be.revertedWithCustomError(env.router, "NotEscalatable");
    });
  });

  describe("the challenge that is a real check — unchanged", function () {
    beforeEach(async function () {
      await registerCircuit(agent.model);
    });

    it("still slashes an agent that will not answer with the proof it could have given", async function () {
      const req = await deliverBronze(agent, await commission(agent.agentId));
      const bondBefore = (await env.registry.getProfile(agent.agentId)).bond;
      const challengerBefore = await env.token.balanceOf(env.challenger.address);

      await env.router.connect(env.challenger).challenge(req.requestId);
      await increaseTime(7 * HOUR);
      await env.router.connect(env.challenger).slashUnresolvedChallenge(req.requestId);

      const after = await env.registry.getProfile(agent.agentId);
      const slashed = (bondBefore * 2_000n) / 10_000n;
      expect(after.bond).to.equal(bondBefore - slashed);
      expect(after.faults).to.equal(1);
      // Bond refunded, plus half the slash as the bounty. This is the payout the fix had to keep
      // intact for honest challengers while denying it against agents that never had a chance.
      expect(await env.token.balanceOf(env.challenger.address)).to.equal(
        challengerBefore + slashed / 2n
      );
      expect((await env.router.getRequest(req.requestId)).status).to.equal(Status.Faulted);
    });

    it("still hands the challenger's bond to an agent that does answer", async function () {
      const req = await deliverBronze(agent, await commission(agent.agentId));
      const ownerBefore = await env.token.balanceOf(env.agentOwner.address);

      await env.router.connect(env.challenger).challenge(req.requestId);
      await env.router
        .connect(agent.operator)
        .resolveChallenge(req.requestId, zkAttestation(req.reveals, OUTPUTS));

      const r = await env.router.getRequest(req.requestId);
      expect(r.status).to.equal(Status.Finalized);
      expect(r.tier).to.equal(Tier.Gold);
      expect(await env.token.balanceOf(env.agentOwner.address)).to.equal(ownerBefore + E18(100));
      expect((await env.registry.getProfile(agent.agentId)).bond).to.equal(E18(1_000_000));
    });

    it("still refuses a challenge after the window, and on the wrong status", async function () {
      const req = await deliverBronze(agent, await commission(agent.agentId));
      await increaseTime(2 * HOUR);
      await expect(
        env.router.connect(env.challenger).challenge(req.requestId)
      ).to.be.revertedWithCustomError(env.router, "DeadlinePassed");

      await env.router.finalize(req.requestId);
      await expect(
        env.router.connect(env.challenger).challenge(req.requestId)
      ).to.be.revertedWithCustomError(env.router, "BadStatus");
    });
  });
});

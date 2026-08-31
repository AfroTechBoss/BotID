const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  E18,
  Tier,
  Status,
  now,
  increaseTime,
  fundedWallet,
  buildBundle,
  revealsFor,
  commitOutputs,
  zkInstances,
  zkAttestation,
  SCALE_BITS,
  deployProtocol,
  registerAgent,
} = require("./helpers");

const HOUR = 3600;
const OUTPUTS = [3300n, 6700n];
const OUT_COMMITMENT = commitOutputs(OUTPUTS);
const MODEL = ethers.id("gold-model");

/**
 * Regression suite for the stolen-attribution vector.
 *
 * `ZkAdapter.verifyAndAttribute` writes `provenBy[workKey]`, and that write is permanent,
 * first-write-wins, and the sole input to every attribution decision the router makes: `deliver`
 * sets `r.attributed = (originator == r.agentId)`, `_settle` scores an unattributed execution at
 * zero weight, and `recordDelivery` — the only thing that raises `demonstratedTier`, which is what
 * `_maxOpenNotional` and `meetsPolicy` actually read — is skipped entirely.
 *
 * The function was `external` with no caller check. Everything that was supposed to make claiming
 * a work key expensive lives in `ExecutionRouter`: a registered agent, a posted bond, a request
 * standing open, a consumer who is not the agent. None of it bound a direct call to the adapter,
 * and `_check` binds only the model and the two commitments — never `ctx.agentId`, never
 * `msg.sender`. So the whole attack was: read a `deliver` out of the mempool, rebuild `ctx` by
 * hand with any agent id at all, and land the adapter call first. Gas only. No registration, no
 * bond, no open request, no operator key, no fee.
 *
 * What it bought was not griefing. The honest agent lost its score update and its
 * `demonstratedTier` ratchet permanently — Gold pinned to Bronze, a 3x cut to its credit line —
 * and the caller could afterwards, at leisure, register a clone on the same model and deliver the
 * same proof to collect the Gold demonstration it had reserved.
 *
 * The fix is `onlyRouter` plus the timelocked `setRouter` the registry already had. The residual
 * this contract documents and accepts — a copier who wins the race *through* the router, holding
 * its own bond against its own standing request — is untouched, and the last two tests here pin
 * that it still behaves the way the header says it does.
 */
describe("stolen attribution — the proof claim that skipped the router", function () {
  let env, agent, attacker;
  let feedNonce = 0;

  beforeEach(async function () {
    env = await deployProtocol();
    agent = await registerAgent(env, { tier: Tier.Gold, bond: E18(1_000_000), model: MODEL });
    await env.zkAdapter.setVerifier(MODEL, env.verifier.target, SCALE_BITS);
    attacker = await fundedWallet(env.owner, "10");
  });

  /**
   * A consumer commissions an execution. `feeds` is returned so a second request can be
   * commissioned over the identical data — same commitment, same instances, same work key —
   * which is what the duplicate-proof cases need.
   */
  async function commission(agentId, opts = {}) {
    const ts = await now();
    const feeds = opts.feeds ?? [
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
      feeds,
      bundle,
      commitment,
      deliverBy: ts + HOUR,
      reveals: revealsFor(feeds),
    };
  }

  async function deliverGold(who, req) {
    await env.router
      .connect(who.operator)
      .deliver(req.requestId, OUT_COMMITMENT, req.bundle, zkAttestation(req.reveals, OUTPUTS));
  }

  /**
   * The context an attacker builds by hand. Every field `_check` inspects is public: the model
   * from `AgentRegistered`, the input commitment from `ExecutionRequested`, the output commitment
   * and the attestation from the pending `deliver` calldata. `agentId` is whatever it likes.
   */
  function forgedCtx(req, agentId) {
    return {
      requestId: req.requestId,
      agentId,
      modelCommitment: MODEL,
      inputCommitment: req.commitment,
      outputCommitment: OUT_COMMITMENT,
      deliverBy: req.deliverBy,
      operator: attacker.address,
    };
  }

  function workKey(req) {
    return env.zkAdapter.workKeyFor(MODEL, zkInstances(req.reveals, OUTPUTS, SCALE_BITS));
  }

  describe("the write itself", function () {
    it("is refused to an arbitrary caller", async function () {
      const req = await commission(agent.agentId);
      await expect(
        env.zkAdapter
          .connect(attacker)
          .verifyAndAttribute(forgedCtx(req, 999n), zkAttestation(req.reveals, OUTPUTS))
      ).to.be.revertedWithCustomError(env.zkAdapter, "NotRouter");
    });

    it("is refused to the owner, who is not the router either", async function () {
      // Worth its own case: the adapter's other write paths are `onlyOwner`, and the point of
      // this one is that owning the adapter is not the same authority as routing an execution.
      const req = await commission(agent.agentId);
      await expect(
        env.zkAdapter
          .connect(env.owner)
          .verifyAndAttribute(forgedCtx(req, agent.agentId), zkAttestation(req.reveals, OUTPUTS))
      ).to.be.revertedWithCustomError(env.zkAdapter, "NotRouter");
    });

    it("is refused even when the attestation is entirely valid", async function () {
      // The attestation below is the honest one, byte for byte — it verifies. Rejection is on
      // the caller, not on the artifact, which is the distinction the whole fix rests on.
      const req = await commission(agent.agentId);
      const attestation = zkAttestation(req.reveals, OUTPUTS);
      expect(await env.zkAdapter.verify(forgedCtx(req, agent.agentId), attestation)).to.equal(true);

      await expect(
        env.zkAdapter.connect(attacker).verifyAndAttribute(forgedCtx(req, agent.agentId), attestation)
      ).to.be.revertedWithCustomError(env.zkAdapter, "NotRouter");
    });

    it("leaves the work key unclaimed, so a failed attempt costs the honest agent nothing", async function () {
      const req = await commission(agent.agentId);
      const key = await workKey(req);

      await expect(
        env.zkAdapter
          .connect(attacker)
          .verifyAndAttribute(forgedCtx(req, 999n), zkAttestation(req.reveals, OUTPUTS))
      ).to.be.reverted;
      expect(await env.zkAdapter.provenBy(key)).to.equal(0n);

      await deliverGold(agent, req);
      expect(await env.zkAdapter.provenBy(key)).to.equal(agent.agentId);
    });
  });

  describe("the front-run, end to end", function () {
    it("cannot take the credit for work it did not do", async function () {
      const req = await commission(agent.agentId);

      // The attacker sees the delivery in the mempool and tries to land first.
      await expect(
        env.zkAdapter
          .connect(attacker)
          .verifyAndAttribute(forgedCtx(req, 4242n), zkAttestation(req.reveals, OUTPUTS))
      ).to.be.revertedWithCustomError(env.zkAdapter, "NotRouter");

      await deliverGold(agent, req);

      const r = await env.router.getRequest(req.requestId);
      expect(r.attributed).to.equal(true);
      expect(r.status).to.equal(Status.Finalized);

      // The ratchet the attack was really after: `demonstratedTier` is what `_maxOpenNotional`
      // and `meetsPolicy` read, and it only moves on an attributed delivery.
      const p = await env.registry.getProfile(agent.agentId);
      expect(p.demonstratedTier).to.equal(Tier.Gold);
    });

    it("cannot suppress the score update either", async function () {
      const req = await commission(agent.agentId);
      const before = await env.registry.getProfile(agent.agentId);

      await expect(
        env.zkAdapter
          .connect(attacker)
          .verifyAndAttribute(forgedCtx(req, 4242n), zkAttestation(req.reveals, OUTPUTS))
      ).to.be.revertedWithCustomError(env.zkAdapter, "NotRouter");

      await deliverGold(agent, req);
      await env.router
        .connect(env.consumer)
        .settle(req.requestId, { realizedPnlBps: 0, slaBreached: false, limitBreached: false });

      const after = await env.registry.getProfile(agent.agentId);
      expect(after.settledExecutions).to.equal(1n);
      // An unattributed settle is weighted at zero and moves nothing. This one moved.
      expect(after.maxOpenNotional).to.be.greaterThan(before.maxOpenNotional);
    });

    it("survives repetition — 10 attempts leave the agent exactly where it should be", async function () {
      for (let i = 0; i < 10; i++) {
        const req = await commission(agent.agentId, { notional: E18(1_000) });
        await expect(
          env.zkAdapter
            .connect(attacker)
            .verifyAndAttribute(forgedCtx(req, 4242n), zkAttestation(req.reveals, OUTPUTS))
        ).to.be.revertedWithCustomError(env.zkAdapter, "NotRouter");

        await deliverGold(agent, req);
        expect((await env.router.getRequest(req.requestId)).attributed).to.equal(true);
        await env.router
          .connect(env.consumer)
          .settle(req.requestId, { realizedPnlBps: 0, slaBreached: false, limitBreached: false });
      }

      const p = await env.registry.getProfile(agent.agentId);
      expect(p.demonstratedTier).to.equal(Tier.Gold);
      expect(p.settledExecutions).to.equal(10n);
      expect(p.faults).to.equal(0n);
    });
  });

  describe("what the fix deliberately does not change", function () {
    it("still scores a duplicate presented through the router at zero", async function () {
      // The documented residual. A second agent, on the same model, delivering the identical
      // proof against its own request: the delivery stands and is paid, but the credit stays
      // with whoever established the work key first.
      const clone = await registerAgent(env, {
        tier: Tier.Gold,
        bond: E18(1_000_000),
        model: MODEL,
      });

      const first = await commission(agent.agentId);
      await deliverGold(agent, first);

      const second = await commission(clone.agentId, { feeds: first.feeds });
      await deliverGold(clone, second);

      expect((await env.router.getRequest(second.requestId)).attributed).to.equal(false);
      expect(await env.zkAdapter.provenBy(await workKey(second))).to.equal(agent.agentId);
      // Paid, finalized, but not demonstrated: possession of a proof is not capability.
      expect((await env.router.getRequest(second.requestId)).status).to.equal(Status.Finalized);
      expect((await env.registry.getProfile(clone.agentId)).demonstratedTier).to.equal(Tier.None);
    });

    it("keeps `verify`, `provenBy` and `workKeyFor` permissionless", async function () {
      // The read path an operator uses to check whether the work it is about to deliver has
      // already been claimed. Gating the write must not gate this, or the check is useless.
      const req = await commission(agent.agentId);
      const attestation = zkAttestation(req.reveals, OUTPUTS);

      expect(
        await env.zkAdapter.connect(attacker).verify(forgedCtx(req, agent.agentId), attestation)
      ).to.equal(true);
      expect(await env.zkAdapter.connect(attacker).provenBy(await workKey(req))).to.equal(0n);
    });
  });

  describe("the router address itself", function () {
    it("is owner-only to set", async function () {
      await expect(
        env.zkAdapter.connect(attacker).setRouter(attacker.address)
      ).to.be.revertedWithCustomError(env.zkAdapter, "NotOwner");
    });

    it("goes behind the timelock once bootstrap is closed", async function () {
      // Repointing the router is repointing who may write attribution, so it gets the same
      // 21-day notice as `AgentRegistry.setRouter`. Before `finalizeBootstrap` it is instant,
      // which is what makes deployment possible at all.
      await env.zkAdapter.finalizeBootstrap();
      await expect(
        env.zkAdapter.setRouter(attacker.address)
      ).to.be.revertedWithCustomError(env.zkAdapter, "NotQueued");

      await env.zkAdapter.queueRouter(attacker.address);
      await expect(
        env.zkAdapter.setRouter(attacker.address)
      ).to.be.revertedWithCustomError(env.zkAdapter, "Premature");

      await increaseTime(21 * 24 * HOUR + 1);
      await env.zkAdapter.setRouter(attacker.address);
      expect(await env.zkAdapter.router()).to.equal(attacker.address);
    });

    it("makes Gold inert rather than open when it is never set", async function () {
      // The safe direction to fail in: a deployment that forgets `zkAdapter.setRouter` cannot
      // deliver at Gold, instead of accepting attribution writes from anywhere.
      const fresh = await (
        await ethers.getContractFactory("ZkAdapter")
      ).deploy(env.owner.address, env.attestor.target);
      await fresh.setVerifier(MODEL, env.verifier.target, SCALE_BITS);
      await env.router.setAdapter(Tier.Gold, fresh.target);

      const req = await commission(agent.agentId);
      await expect(deliverGold(agent, req)).to.be.revertedWithCustomError(fresh, "NotRouter");
    });
  });
});

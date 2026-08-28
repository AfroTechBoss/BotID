const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  E18,
  Tier,
  Status,
  coder,
  now,
  increaseTime,
  fundedWallet,
  signDigest,
  executionDigest,
  buildBundle,
  revealsFor,
  commitOutputs,
  SCALE_BITS,
  zkAttestation,
  teeAttestation,
  deployProtocol,
  registerAgent,
} = require("./helpers");

const HOUR = 3600;
const DAY = 24 * HOUR;
const CLEAN = { realizedPnlBps: 0, slaBreached: false, limitBreached: false };

let feedNonce = 0;

/**
 * Lift `consumerWeightCap` out of the way, leaving every other engine parameter as it was.
 *
 * A handful of tests below are about how a *single* execution is weighted, or about faults versus
 * volume. Those run one consumer through several settlements, which the per-consumer budget is
 * specifically designed to discount — so they set it aside to isolate what they are measuring.
 * The budget has its own test.
 */
async function liftConsumerCap(env) {
  await env.engine.setParameters(
    await env.engine.halfWeight(),
    await env.engine.weightCap(),
    (1n << 128n) - 1n, // the largest the engine will accept — budgets are stored in 128 bits
    await env.engine.decayHalfLife(),
    await env.engine.livenessHaircutBps(),
    await env.engine.verificationHaircutBps()
  );
}

/** A consumer protocol commissions an execution, fixing the input data itself. */
async function commission(env, agentId, opts = {}) {
  const ts = await now();
  // A price quantised at the model's declared input scale, plus the salt that hides it until
  // a Gold proof opens it. Distinct per request so no two commitments collide.
  const feeds = [
    {
      feedId: ethers.id("BOT/USD"),
      value: BigInt(12_500 + feedNonce),
      salt: ethers.id(`salt-${feedNonce++}`),
      timestamp: ts,
    },
  ];
  const { bundle, commitment } = buildBundle(env.chainId, env.attestor.target, feeds, [env.publisher]);
  const deliverBy = ts + (opts.window ?? HOUR);
  const notional = opts.notional ?? E18(100_000);

  // Default to exactly the fee floor, which is what a real consumer paying the minimum does.
  // Cases that assert on fee flows pass an explicit fee.
  const minFeeBps = await env.router.minFeeBps();
  const fee = opts.fee ?? (notional * minFeeBps) / 10_000n;

  const tx = await env.router
    .connect(env.consumer)
    .requestExecution(agentId, commitment, notional, fee, deliverBy, opts.inputURI ?? "");
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
    deliverBy,
    reveals: revealsFor(feeds),
  };
}

// The outputs every delivery in this suite claims. Bronze commits to the hash; a Gold proof
// later has to reproduce the vector itself, which is why they share one definition here.
const OUTPUTS = [3300n, 6700n];
const OUT_COMMITMENT = commitOutputs(OUTPUTS);

function makeCtx(agent, req, outputCommitment) {
  return {
    requestId: req.requestId,
    agentId: agent.agentId,
    modelCommitment: agent.model,
    inputCommitment: req.commitment,
    outputCommitment,
    deliverBy: req.deliverBy,
    operator: agent.operator.address,
  };
}

async function deliverBronze(env, agent, req, outputCommitment = OUT_COMMITMENT) {
  const ctx = makeCtx(agent, req, outputCommitment);
  const sig = signDigest(agent.operator, executionDigest(env.chainId, env.sigAdapter.target, ctx));
  await env.router.connect(agent.operator).deliver(req.requestId, outputCommitment, req.bundle, sig);
  return ctx;
}

describe("ExecutionRouter", function () {
  let env, agent;

  beforeEach(async function () {
    env = await deployProtocol();
    agent = await registerAgent(env, { bond: E18(1_000_000), tier: Tier.Bronze });
    await env.zkAdapter.setVerifier(agent.model, env.verifier.target, SCALE_BITS);
  });

  describe("request", function () {
    it("escrows the fee and reserves exposure", async function () {
      const before = await env.token.balanceOf(env.consumer.address);
      const req = await commission(env, agent.agentId);

      expect(await env.token.balanceOf(env.consumer.address)).to.equal(before - E18(100));
      expect(await env.token.balanceOf(env.router.target)).to.equal(E18(100));

      const p = await env.registry.getProfile(agent.agentId);
      expect(p.openNotional).to.equal(E18(100_000));

      const r = await env.router.getRequest(req.requestId);
      expect(r.status).to.equal(Status.Pending);
      expect(r.consumer).to.equal(env.consumer.address);
    });

    it("refuses a notional beyond the agent's credit limit", async function () {
      // Bond 1,000,000 x 1.0 leverage x 0.5 Bronze factor = 500,000.
      await expect(commission(env, agent.agentId, { notional: E18(500_001) })).to.be.revertedWithCustomError(
        env.registry,
        "CreditExceeded"
      );
    });

    // A deadline in the past is now caught by the same floor that catches a deadline merely too
    // soon — `minDeliveryWindow`. See LivenessGrief.test.js for why that floor exists.
    it("refuses a deadline in the past", async function () {
      const ts = await now();
      await expect(
        env.router.connect(env.consumer).requestExecution(agent.agentId, ethers.ZeroHash, 0, 0, ts, "")
      ).to.be.revertedWithCustomError(env.router, "DeliveryWindowTooShort");
    });

    // The protocol's take is a cut of `fee`, and `fee` is set by the consumer. Without a floor,
    // a consumer and an agent who know each other pay zero on chain, settle privately, and take
    // the service for free — so the floor is priced against notional instead.
    it("refuses a fee below the floor", async function () {
      await expect(
        commission(env, agent.agentId, { notional: E18(100_000), fee: E18(9) })
      ).to.be.revertedWithCustomError(env.router, "FeeBelowFloor");
    });

    it("closes the collusion path: a zero fee on real notional is rejected", async function () {
      await expect(
        commission(env, agent.agentId, { notional: E18(100_000), fee: 0 })
      ).to.be.revertedWithCustomError(env.router, "FeeBelowFloor");
    });

    it("accepts a fee exactly at the floor", async function () {
      const req = await commission(env, agent.agentId, { notional: E18(100_000), fee: E18(100) });
      expect((await env.router.getRequest(req.requestId)).fee).to.equal(E18(100));
    });

    it("scales the floor with notional", async function () {
      // 10 bps: the same fee that clears 100,000 of notional is short against 400,000.
      await expect(
        commission(env, agent.agentId, { notional: E18(400_000), fee: E18(100) })
      ).to.be.revertedWithCustomError(env.router, "FeeBelowFloor");
      await commission(env, agent.agentId, { notional: E18(400_000), fee: E18(400) });
    });

    it("refuses a request with nothing at risk", async function () {
      // A zero-notional request used to be allowed on the reading that there is nothing to price
      // against. But it is still a live, still-slashable obligation, and `reserve(agentId, 0)`
      // adds nothing to `openNotional` — which is the whole of `withdrawEarly`'s liability gate.
      // A consumer could park one against an agent, watch it walk out with its bond, and leave
      // `_slash` computing a percentage of nothing. See ZeroNotional in ExecutionRouter.
      await expect(
        commission(env, agent.agentId, { notional: 0, fee: 0 })
      ).to.be.revertedWithCustomError(env.router, "ZeroNotional");
    });

    it("keeps a live request visible to the liability gate", async function () {
      // The property the check above exists to protect: while any request is open, the agent's
      // recorded exposure is non-zero, so the early-exit gate can see it and refuses.
      await env.registry.connect(env.agentOwner).startUnbonding(agent.agentId, E18(1_000));
      await commission(env, agent.agentId, { notional: E18(1_000) });
      expect((await env.registry.getAgent(agent.agentId)).openNotional).to.be.greaterThan(0n);
      await expect(
        env.registry.connect(env.agentOwner).withdrawEarly(agent.agentId)
      ).to.be.revertedWithCustomError(env.registry, "OutstandingLiability");
    });

    it("lets the owner disable the floor for bootstrapping", async function () {
      await env.router.setMinFeeBps(0);
      const req = await commission(env, agent.agentId, { notional: E18(100_000), fee: 0 });
      expect((await env.router.getRequest(req.requestId)).fee).to.equal(0);
    });

    it("caps the floor well below a halt", async function () {
      // A floor near 100% of notional is not a fee, it is a halt that looks like a bug.
      await expect(env.router.setMinFeeBps(1_001)).to.be.revertedWithCustomError(
        env.router,
        "InvalidParameter"
      );
      await env.router.setMinFeeBps(1_000);
      expect(await env.router.minFeeBps()).to.equal(1_000);
    });

    it("only the owner may move the floor", async function () {
      await expect(env.router.connect(env.consumer).setMinFeeBps(0)).to.be.reverted;
    });

    it("mints a distinct id per request", async function () {
      const a = await commission(env, agent.agentId, { notional: E18(1000) });
      const b = await commission(env, agent.agentId, { notional: E18(1000) });
      expect(a.requestId).to.not.equal(b.requestId);
    });
  });

  describe("delivery", function () {
    it("accepts a signed delivery inside the deadline", async function () {
      const req = await commission(env, agent.agentId);
      await deliverBronze(env, agent, req);

      const r = await env.router.getRequest(req.requestId);
      expect(r.status).to.equal(Status.Delivered);
      expect(r.tier).to.equal(Tier.Bronze);
      expect(r.outputCommitment).to.equal(OUT_COMMITMENT);
    });

    it("rejects delivery from anyone but the agent's operator", async function () {
      const req = await commission(env, agent.agentId);
      const impostor = await fundedWallet(env.owner, "1");
      const ctx = makeCtx(agent, req, ethers.id("out-1"));
      const sig = signDigest(impostor, executionDigest(env.chainId, env.sigAdapter.target, ctx));

      await expect(
        env.router.connect(impostor).deliver(req.requestId, ethers.id("out-1"), req.bundle, sig)
      ).to.be.revertedWithCustomError(env.router, "NotOperator");
    });

    it("rejects delivery after the deadline", async function () {
      const req = await commission(env, agent.agentId);
      await increaseTime(2 * HOUR);

      const ctx = makeCtx(agent, req, ethers.id("out-1"));
      const sig = signDigest(agent.operator, executionDigest(env.chainId, env.sigAdapter.target, ctx));
      await expect(
        env.router.connect(agent.operator).deliver(req.requestId, ethers.id("out-1"), req.bundle, sig)
      ).to.be.revertedWithCustomError(env.router, "DeadlinePassed");
    });

    it("rejects inputs the agent chose for itself", async function () {
      // The headline attack: run the model on fabricated data, attest it perfectly.
      const req = await commission(env, agent.agentId);
      const forged = buildBundle(
        env.chainId,
        env.attestor.target,
        [{ feedId: ethers.id("BOT/USD"), valueHash: ethers.id("fake"), timestamp: await now() }],
        [env.publisher]
      );

      const ctx = makeCtx(agent, req, ethers.id("out-1"));
      const sig = signDigest(agent.operator, executionDigest(env.chainId, env.sigAdapter.target, ctx));
      await expect(
        env.router.connect(agent.operator).deliver(req.requestId, ethers.id("out-1"), forged.bundle, sig)
      ).to.be.revertedWithCustomError(env.router, "InputAttestationFailed");
    });

    it("rejects an attestation minted for a different request", async function () {
      const first = await commission(env, agent.agentId, { notional: E18(1000) });
      const second = await commission(env, agent.agentId, { notional: E18(1000) });

      const ctx = makeCtx(agent, first, ethers.id("out-1"));
      const sig = signDigest(agent.operator, executionDigest(env.chainId, env.sigAdapter.target, ctx));

      await expect(
        env.router.connect(agent.operator).deliver(second.requestId, ethers.id("out-1"), second.bundle, sig)
      ).to.be.revertedWithCustomError(env.router, "VerificationFailed");
    });

    it("cannot be delivered twice", async function () {
      const req = await commission(env, agent.agentId);
      await deliverBronze(env, agent, req);

      const ctx = makeCtx(agent, req, ethers.id("out-1"));
      const sig = signDigest(agent.operator, executionDigest(env.chainId, env.sigAdapter.target, ctx));
      await expect(
        env.router.connect(agent.operator).deliver(req.requestId, ethers.id("out-1"), req.bundle, sig)
      ).to.be.revertedWithCustomError(env.router, "BadStatus");
    });

    it("finalizes a Gold delivery immediately, with no challenge window", async function () {
      const gold = await registerAgent(env, { bond: E18(1_000_000), tier: Tier.Gold, model: ethers.id("gold-model") });
      await env.zkAdapter.setVerifier(gold.model, env.verifier.target, SCALE_BITS);

      const req = await commission(env, gold.agentId);
      await env.router
        .connect(gold.operator)
        .deliver(
          req.requestId,
          OUT_COMMITMENT,
          req.bundle,
          zkAttestation(req.reveals, OUTPUTS)
        );

      const r = await env.router.getRequest(req.requestId);
      expect(r.status).to.equal(Status.Finalized);
      expect(r.tier).to.equal(Tier.Gold);

      await expect(env.router.connect(env.challenger).challenge(req.requestId)).to.be.revertedWithCustomError(
        env.router,
        "BadStatus"
      );
    });

    it("accepts a Silver delivery from an enrolled enclave", async function () {
      const measurement = ethers.id("pcr0-x");
      const enclave = await fundedWallet(env.owner, "1");
      await env.teeAdapter.setNotary(env.owner.address, true);
      await env.teeAdapter.setMeasurement(measurement, true);
      await env.teeAdapter.enroll(enclave.address, measurement, (await now()) + 6 * DAY);

      const silver = await registerAgent(env, { bond: E18(1_000_000), tier: Tier.Silver, model: ethers.id("llm") });
      const req = await commission(env, silver.agentId);
      const output = ethers.id("out-silver");
      const ctx = makeCtx(silver, req, output);

      const digest = ethers.keccak256(
        coder.encode(
          ["bytes32", "bytes32"],
          [executionDigest(env.chainId, env.teeAdapter.target, ctx), measurement]
        )
      );
      const attestation = teeAttestation(enclave.address, signDigest(enclave, digest));

      await env.router.connect(silver.operator).deliver(req.requestId, output, req.bundle, attestation);
      expect((await env.router.getRequest(req.requestId)).status).to.equal(Status.Delivered);
    });
  });

  /**
   * The registry gates `withdrawEarly` on `openNotional == 0`, which is only a real liability
   * check if exposure survives until an execution is genuinely over. That is a property of this
   * contract, not of the registry, so it is asserted here: the registry cannot tell the
   * difference between "released because settled" and "released too early".
   */
  describe("exposure as the liability gate", function () {
    it("holds the fast exit shut from delivery until settlement", async function () {
      const req = await commission(env, agent.agentId, { notional: E18(100_000) });
      await env.registry.connect(env.agentOwner).startUnbonding(agent.agentId, E18(100_000));

      // Delivered, inside the challenge window, nothing settled. This is the exact state the gate
      // exists for — the agent has done the work and the outcome can still go against it.
      await deliverBronze(env, agent, req);
      expect((await env.router.getRequest(req.requestId)).status).to.equal(Status.Delivered);
      expect((await env.registry.getAgent(agent.agentId)).openNotional).to.equal(E18(100_000));
      await expect(
        env.registry.connect(env.agentOwner).withdrawEarly(agent.agentId)
      ).to.be.revertedWithCustomError(env.registry, "OutstandingLiability");

      // Finalized is not over either: the challenge window has closed but the outcome has not
      // been recorded, so the score has not moved and the fee has not been paid.
      await increaseTime(2 * HOUR);
      await env.router.finalize(req.requestId);
      expect((await env.registry.getAgent(agent.agentId)).openNotional).to.equal(E18(100_000));
      await expect(
        env.registry.connect(env.agentOwner).withdrawEarly(agent.agentId)
      ).to.be.revertedWithCustomError(env.registry, "OutstandingLiability");

      await env.router.connect(env.consumer).settle(req.requestId, CLEAN);
      expect((await env.registry.getAgent(agent.agentId)).openNotional).to.equal(0);
      await env.registry.connect(env.agentOwner).withdrawEarly(agent.agentId);
    });

    it("holds it shut through a live challenge, and the slash lands first", async function () {
      const req = await commission(env, agent.agentId, { notional: E18(100_000) });
      await env.registry.connect(env.agentOwner).startUnbonding(agent.agentId, E18(100_000));
      await deliverBronze(env, agent, req);
      await env.router.connect(env.challenger).challenge(req.requestId);

      await expect(
        env.registry.connect(env.agentOwner).withdrawEarly(agent.agentId)
      ).to.be.revertedWithCustomError(env.registry, "OutstandingLiability");

      // The agent lets the escalation window lapse rather than answering with a proof. Exposure
      // is released here too — but only after the bond has already been cut for it, which is the
      // ordering the whole gate depends on.
      const bondBefore = (await env.registry.getAgent(agent.agentId)).bond;
      await increaseTime(7 * HOUR);
      await env.router.slashUnresolvedChallenge(req.requestId);

      const after = await env.registry.getAgent(agent.agentId);
      expect(after.openNotional).to.equal(0);
      expect(after.bond).to.equal(bondBefore - (bondBefore * 2_000n) / 10_000n);
      // Now it may leave, having paid for the fault first — which is the whole point of the
      // ordering. The slash came out of the bond before any of it could be withdrawn, so what
      // walks out is 100,000 of the 800,000 that survived, not 100,000 of the original million.
      await env.registry.connect(env.agentOwner).withdrawEarly(agent.agentId);
      expect((await env.registry.getAgent(agent.agentId)).bond).to.equal(E18(700_000));
    });
  });

  describe("settlement", function () {
    it("pays the agent, cuts the protocol fee, releases exposure and lifts the score", async function () {
      const req = await commission(env, agent.agentId, { notional: E18(100_000), fee: E18(100) });
      await deliverBronze(env, agent, req);
      await increaseTime(2 * HOUR);
      await env.router.finalize(req.requestId);

      const ownerBefore = await env.token.balanceOf(env.agentOwner.address);
      const treasuryBefore = await env.token.balanceOf(env.treasury.address);

      await env.router.connect(env.consumer).settle(req.requestId, CLEAN);

      expect(await env.token.balanceOf(env.agentOwner.address)).to.equal(ownerBefore + E18(95));
      expect(await env.token.balanceOf(env.treasury.address)).to.equal(treasuryBefore + E18(5));

      const p = await env.registry.getProfile(agent.agentId);
      expect(p.openNotional).to.equal(0);
      expect(p.settledExecutions).to.equal(1);
      expect(p.score).to.be.greaterThan(5000);
      expect((await env.router.getRequest(req.requestId)).status).to.equal(Status.Settled);
    });

    it("weights the score update by capital at risk", async function () {
      await liftConsumerCap(env);
      const small = await registerAgent(env, { bond: E18(1_000_000), model: ethers.id("m-small") });
      const large = await registerAgent(env, { bond: E18(1_000_000), model: ethers.id("m-large") });

      for (const [who, notional] of [
        [small, E18(100)],
        [large, E18(400_000)],
      ]) {
        const req = await commission(env, who.agentId, { notional });
        await deliverBronze(env, who, req);
        await increaseTime(2 * HOUR);
        await env.router.finalize(req.requestId);
        await env.router.connect(env.consumer).settle(req.requestId, CLEAN);
      }

      // A 100-unit execution barely registers; a 400,000-unit one dominates. Under the v0
      // flat "+10 per verified execution" both would have moved the score identically.
      const smallScore = Number((await env.registry.getProfile(small.agentId)).score);
      const largeScore = Number((await env.registry.getProfile(large.agentId)).score);
      expect(smallScore).to.be.at.most(5010);
      expect(largeScore).to.be.greaterThan(8000);
    });

    it("lowers the score on a breached outcome", async function () {
      const req = await commission(env, agent.agentId, { notional: E18(300_000) });
      await deliverBronze(env, agent, req);
      await increaseTime(2 * HOUR);
      await env.router.finalize(req.requestId);

      await env.router
        .connect(env.consumer)
        .settle(req.requestId, { realizedPnlBps: -3000, slaBreached: true, limitBreached: true });

      expect((await env.registry.getProfile(agent.agentId)).score).to.be.lessThan(5000);
    });

    it("does not let one counterparty destroy a score with one report", async function () {
      // `settle` takes the consumer's word for the outcome, and the consumer also chooses the
      // notional the outcome is weighted by — so the damage of a false report scales with a number
      // the liar picks, while the cost is `minFeeBps` of it. Raising the fee floor cannot close
      // that gap; `consumerWeightCap` does, by denying any single counterparty the ability to
      // define an agent's reputation. See ReputationEngine.consumerWeightCap.
      const RUINOUS = { realizedPnlBps: -3000, slaBreached: true, limitBreached: true };

      const settleAs = async (outcome, notional) => {
        const req = await commission(env, agent.agentId, { notional });
        await deliverBronze(env, agent, req, ethers.id(`grief-${req.requestId}`));
        await increaseTime(2 * HOUR);
        await env.router.finalize(req.requestId);
        await env.router.connect(env.consumer).settle(req.requestId, outcome);
        return Number((await env.registry.getProfile(agent.agentId)).score);
      };

      // The outcome is as bad as one can be reported: quality zero. Uncapped, a 400,000 notional
      // weighs 400,000 against a halfWeight of 100,000 — 80% of the distance to zero, taking a
      // neutral 5,000 down to about 1,000. Budgeted at 50,000 it weighs a third instead.
      const after = await settleAs(RUINOUS, E18(400_000));
      expect(after).to.be.greaterThan(3_000);
      expect(after).to.be.lessThan(3_500);

      // And a second report buys almost nothing: the budget is spent, and refills only on the
      // 90-day half-life the score itself decays on. Two hours of that is worth a rounding error,
      // not a second bite. Smaller, because the first report already cut the agent's credit line —
      // and the budget would clamp the weight to the same rounding error at any size.
      expect(await settleAs(RUINOUS, E18(50_000))).to.be.greaterThan(3_000);
      const cap = await env.engine.consumerWeightCap();
      expect(await env.engine.remainingWeight(agent.agentId, env.consumer.address)).to.be.lessThan(
        cap / 100n
      );

      // A different counterparty is unaffected — reputation aggregates across them.
      expect(await env.engine.remainingWeight(agent.agentId, env.other.address)).to.equal(cap);
    });

    it("only the commissioning consumer may settle", async function () {
      const req = await commission(env, agent.agentId);
      await deliverBronze(env, agent, req);
      await increaseTime(2 * HOUR);
      await env.router.finalize(req.requestId);

      await expect(
        env.router.connect(env.other).settle(req.requestId, CLEAN)
      ).to.be.revertedWithCustomError(env.router, "NotConsumer");
    });

    it("cannot settle before finalization", async function () {
      const req = await commission(env, agent.agentId);
      await deliverBronze(env, agent, req);
      await expect(
        env.router.connect(env.consumer).settle(req.requestId, CLEAN)
      ).to.be.revertedWithCustomError(env.router, "BadStatus");
    });

    it("cannot finalize before the challenge window closes", async function () {
      const req = await commission(env, agent.agentId);
      await deliverBronze(env, agent, req);
      await expect(env.router.finalize(req.requestId)).to.be.revertedWithCustomError(
        env.router,
        "DeadlineNotPassed"
      );
    });

    it("lets anyone settle at par once the window lapses, so a silent consumer cannot grief", async function () {
      const req = await commission(env, agent.agentId, { notional: E18(200_000) });
      await deliverBronze(env, agent, req);
      await increaseTime(2 * HOUR);
      await env.router.finalize(req.requestId);

      await expect(env.router.settleDefault(req.requestId)).to.be.revertedWithCustomError(
        env.router,
        "DeadlineNotPassed"
      );

      await increaseTime(8 * DAY);
      await env.router.connect(env.other).settleDefault(req.requestId);

      const p = await env.registry.getProfile(agent.agentId);
      expect(p.openNotional).to.equal(0);
      // Exposure released, fee paid, score untouched. This assertion used to read
      // `greaterThan(5000)` and was describing a bug rather than a requirement: nobody reported
      // anything here, so there is nothing for the score to have learned. See
      // SilentSettleGrief.test.js for what that reward was worth to an attacker.
      expect(p.score).to.equal(5000);
    });

    it("refuses a late settle from the consumer", async function () {
      const req = await commission(env, agent.agentId);
      await deliverBronze(env, agent, req);
      await increaseTime(2 * HOUR);
      await env.router.finalize(req.requestId);
      await increaseTime(8 * DAY);

      await expect(
        env.router.connect(env.consumer).settle(req.requestId, CLEAN)
      ).to.be.revertedWithCustomError(env.router, "DeadlinePassed");
    });
  });

  describe("liveness — the fault the v0 design could not observe", function () {
    it("penalises an accepted request that was never delivered", async function () {
      const req = await commission(env, agent.agentId, { notional: E18(100_000), fee: E18(100) });
      const consumerBefore = await env.token.balanceOf(env.consumer.address);
      const callerBefore = await env.token.balanceOf(env.other.address);

      await increaseTime(2 * HOUR);
      await env.router.connect(env.other).markExpired(req.requestId);

      // 2% of a 1,000,000 bond, half of it to whoever reported the failure.
      expect(await env.token.balanceOf(env.other.address)).to.equal(callerBefore + E18(10_000));
      expect(await env.token.balanceOf(env.consumer.address)).to.equal(consumerBefore + E18(100));

      const p = await env.registry.getProfile(agent.agentId);
      expect(p.faults).to.equal(1);
      expect(p.bond).to.equal(E18(980_000));
      expect(p.openNotional).to.equal(0);
      expect(p.score).to.equal(4250); // 5000 x (1 - 15%)
      expect((await env.router.getRequest(req.requestId)).status).to.equal(Status.Expired);
    });

    it("cannot be reported before the deadline", async function () {
      const req = await commission(env, agent.agentId);
      await expect(env.router.markExpired(req.requestId)).to.be.revertedWithCustomError(
        env.router,
        "DeadlineNotPassed"
      );
    });

    it("cannot be reported twice", async function () {
      const req = await commission(env, agent.agentId);
      await increaseTime(2 * HOUR);
      await env.router.markExpired(req.requestId);
      await expect(env.router.markExpired(req.requestId)).to.be.revertedWithCustomError(
        env.router,
        "BadStatus"
      );
    });

    it("is not diluted by a large volume of clean executions", async function () {
      await liftConsumerCap(env);
      for (let i = 0; i < 3; i++) {
        const r = await commission(env, agent.agentId, { notional: E18(400_000) });
        await deliverBronze(env, agent, r, ethers.id(`out-${i}`));
        await increaseTime(2 * HOUR);
        await env.router.finalize(r.requestId);
        await env.router.connect(env.consumer).settle(r.requestId, CLEAN);
      }
      const before = Number((await env.registry.getProfile(agent.agentId)).score);
      expect(before).to.be.greaterThan(9000);

      const bad = await commission(env, agent.agentId, { notional: E18(1000) });
      await increaseTime(2 * HOUR);
      await env.router.markExpired(bad.requestId);

      const after = Number((await env.registry.getProfile(agent.agentId)).score);
      expect(after).to.be.lessThan(Math.floor(before * 0.9));
    });
  });

  describe("challenge and escalation", function () {
    it("returns the challenger's bond to the agent when a Gold proof arrives", async function () {
      const req = await commission(env, agent.agentId);
      await deliverBronze(env, agent, req);

      const ownerBefore = await env.token.balanceOf(env.agentOwner.address);
      const challengerBefore = await env.token.balanceOf(env.challenger.address);

      await env.router.connect(env.challenger).challenge(req.requestId);
      expect((await env.router.getRequest(req.requestId)).status).to.equal(Status.Challenged);

      await env.router
        .connect(agent.operator)
        .resolveChallenge(req.requestId, zkAttestation(req.reveals, OUTPUTS));

      const r = await env.router.getRequest(req.requestId);
      expect(r.status).to.equal(Status.Finalized);
      expect(r.tier).to.equal(Tier.Gold);
      expect(await env.token.balanceOf(env.agentOwner.address)).to.equal(ownerBefore + E18(100));
      expect(await env.token.balanceOf(env.challenger.address)).to.equal(challengerBefore - E18(100));
    });

    it("rejects an escalation proof that does not describe the delivered execution", async function () {
      const req = await commission(env, agent.agentId);
      await deliverBronze(env, agent, req);
      await env.router.connect(env.challenger).challenge(req.requestId);

      // A perfectly valid proof — of a different output vector than the one delivered under.
      await expect(
        env.router
          .connect(agent.operator)
          .resolveChallenge(req.requestId, zkAttestation(req.reveals, [10_000n, 0n]))
      ).to.be.revertedWithCustomError(env.router, "VerificationFailed");
    });

    it("slashes the agent and pays the challenger when no proof arrives", async function () {
      const req = await commission(env, agent.agentId, { notional: E18(100_000), fee: E18(100) });
      await deliverBronze(env, agent, req);

      const challengerBefore = await env.token.balanceOf(env.challenger.address);
      const consumerBefore = await env.token.balanceOf(env.consumer.address);

      await env.router.connect(env.challenger).challenge(req.requestId);
      await increaseTime(7 * HOUR);
      await env.router.connect(env.other).slashUnresolvedChallenge(req.requestId);

      // 20% of a 1,000,000 bond slashed; half of that to the challenger, plus its bond back.
      expect(await env.token.balanceOf(env.challenger.address)).to.equal(
        challengerBefore + E18(100_000)
      );
      expect(await env.token.balanceOf(env.consumer.address)).to.equal(consumerBefore + E18(100));

      const p = await env.registry.getProfile(agent.agentId);
      expect(p.bond).to.equal(E18(800_000));
      expect(p.faults).to.equal(1);
      expect(p.openNotional).to.equal(0);
      expect(p.score).to.equal(2000); // 5000 x (1 - 60%)
      expect((await env.router.getRequest(req.requestId)).status).to.equal(Status.Faulted);
    });

    it("cannot be slashed while the escalation window is still open", async function () {
      const req = await commission(env, agent.agentId);
      await deliverBronze(env, agent, req);
      await env.router.connect(env.challenger).challenge(req.requestId);

      await expect(
        env.router.slashUnresolvedChallenge(req.requestId)
      ).to.be.revertedWithCustomError(env.router, "DeadlineNotPassed");
    });

    it("cannot be resolved once the escalation window closes", async function () {
      const req = await commission(env, agent.agentId);
      await deliverBronze(env, agent, req);
      await env.router.connect(env.challenger).challenge(req.requestId);
      await increaseTime(7 * HOUR);

      await expect(
        env.router
          .connect(agent.operator)
          .resolveChallenge(req.requestId, zkAttestation(req.reveals, OUTPUTS))
      ).to.be.revertedWithCustomError(env.router, "DeadlinePassed");
    });

    it("cannot be challenged after the window closes", async function () {
      const req = await commission(env, agent.agentId);
      await deliverBronze(env, agent, req);
      await increaseTime(2 * HOUR);

      await expect(
        env.router.connect(env.challenger).challenge(req.requestId)
      ).to.be.revertedWithCustomError(env.router, "DeadlinePassed");
    });

    it("cannot be challenged twice", async function () {
      const req = await commission(env, agent.agentId);
      await deliverBronze(env, agent, req);
      await env.router.connect(env.challenger).challenge(req.requestId);

      await expect(
        env.router.connect(env.other).challenge(req.requestId)
      ).to.be.revertedWithCustomError(env.router, "BadStatus");
    });
  });

  describe("configuration", function () {
    it("refuses a settlement window that would outlive the unbonding period", async function () {
      await expect(
        env.router.setParameters(HOUR, 6 * HOUR, 25 * DAY, E18(100), 2000, 200, 5000, 500)
      ).to.be.revertedWithCustomError(env.router, "InvalidParameter");
    });

    it("refuses a challenge bond larger than the field that has to hold it", async function () {
      // The bond is collected as a uint256 and recorded as a uint128, and the refund pays out the
      // recorded field. Above 2^128 those two are different numbers and the gap is unrecoverable,
      // so the value is refused at the governance call rather than truncated at the challenge.
      await expect(
        env.router.setParameters(HOUR, 6 * HOUR, DAY, 1n << 128n, 2000, 200, 5000, 500)
      ).to.be.revertedWithCustomError(env.router, "InvalidParameter");

      // One below the boundary is legal, so the bound is a ceiling and not an off-by-one.
      await env.router.setParameters(
        HOUR, 6 * HOUR, DAY, (1n << 128n) - 1n, 2000, 200, 5000, 500
      );
      expect(await env.router.challengeBondAmount()).to.equal((1n << 128n) - 1n);
    });

    it("pays a challenger back exactly what it posted", async function () {
      // The property the bound above exists to protect, asserted directly rather than inferred.
      const bond = await env.router.challengeBondAmount();
      const req = await commission(env, agent.agentId);
      await deliverBronze(env, agent, req);

      const before = await env.token.balanceOf(env.challenger.address);
      await env.router.connect(env.challenger).challenge(req.requestId);
      expect(before - (await env.token.balanceOf(env.challenger.address))).to.equal(bond);

      await increaseTime(Number(await env.router.escalationWindow()) + 1);
      await env.router.slashUnresolvedChallenge(req.requestId);
      expect(await env.token.balanceOf(env.challenger.address)).to.be.at.least(before);
    });

    it("refuses an adapter registered under the wrong tier", async function () {
      await expect(
        env.router.setAdapter(Tier.Gold, env.sigAdapter.target)
      ).to.be.revertedWithCustomError(env.router, "InvalidParameter");
    });

    it("reverts delivery when no adapter is configured for the agent's tier", async function () {
      await env.router.setAdapter(Tier.Bronze, ethers.ZeroAddress);
      const req = await commission(env, agent.agentId);

      const ctx = makeCtx(agent, req, ethers.id("out-1"));
      const sig = signDigest(agent.operator, executionDigest(env.chainId, env.sigAdapter.target, ctx));
      await expect(
        env.router.connect(agent.operator).deliver(req.requestId, ethers.id("out-1"), req.bundle, sig)
      ).to.be.revertedWithCustomError(env.router, "NoAdapter");
    });

    it("only the owner may reconfigure", async function () {
      await expect(
        env.router.connect(env.other).setAdapter(Tier.Bronze, env.sigAdapter.target)
      ).to.be.revertedWithCustomError(env.router, "NotOwner");
    });

    it("rejects operations on an unknown request", async function () {
      await expect(env.router.finalize(ethers.id("nope"))).to.be.revertedWithCustomError(
        env.router,
        "UnknownRequest"
      );
    });
  });

  describe("engine access control", function () {
    it("refuses writes from anyone but the registry and router", async function () {
      await expect(
        env.engine.connect(env.other).recordFault(agent.agentId, 0)
      ).to.be.revertedWithCustomError(env.engine, "NotWriter");
      await expect(env.engine.connect(env.other).initAgent(99)).to.be.revertedWithCustomError(
        env.engine,
        "NotWriter"
      );
    });

    it("refuses to initialise an agent twice", async function () {
      await env.engine.setWriter(env.owner.address, true);
      await expect(env.engine.initAgent(agent.agentId)).to.be.revertedWithCustomError(
        env.engine,
        "AlreadyInitialized"
      );
    });
  });
});

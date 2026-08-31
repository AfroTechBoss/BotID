const { expect } = require("chai");
const { ethers } = require("hardhat");
const { E18, Tier, deployProtocol, registerAgent, increaseTime, fundedWallet } = require("./helpers");

const DAY = 24 * 60 * 60;

describe("AgentRegistry", function () {
  let env;

  beforeEach(async function () {
    env = await deployProtocol();
  });

  describe("registration", function () {
    it("locks the bond and starts the agent at neutral", async function () {
      const before = await env.token.balanceOf(env.agentOwner.address);
      const { agentId } = await registerAgent(env, { bond: E18(1000) });

      expect(await env.token.balanceOf(env.agentOwner.address)).to.equal(before - E18(1000));
      const p = await env.registry.getProfile(agentId);
      expect(p.score).to.equal(5000);
      expect(p.bond).to.equal(E18(1000));
      expect(p.active).to.equal(true);
    });

    it("refuses to hold a bond in a token that does not exist", async function () {
      // A low-level call to a codeless address succeeds and returns nothing, which is exactly what
      // a well-behaved non-standard ERC20 returns on a real transfer. Without a code check the
      // registry cannot tell the two apart: the bond appears locked, `getProfile` reports it, and
      // the tokens were never anywhere. The mistake is a wrong constructor argument, so the revert
      // has to land on the first deposit — there is no later point at which anything complains.
      const codeless = env.other.address;
      expect(await ethers.provider.getCode(codeless)).to.equal("0x");

      const registry = await (
        await ethers.getContractFactory("AgentRegistry")
      ).deploy(env.owner.address, codeless, env.engine.target, env.treasury.address);
      await env.engine.setWriter(registry.target, true);

      const op = await fundedWallet(env.owner, "1");
      await expect(
        registry
          .connect(env.agentOwner)
          .registerAgent(op.address, ethers.id("m"), Tier.Bronze, 500, E18(1000))
      ).to.be.revertedWithCustomError(registry, "NotAContract");

      // And nothing was recorded on the way to that revert.
      expect(await registry.agentIdByOperator(op.address)).to.equal(0n);
    });

    it("rejects a bond below the minimum", async function () {
      const op = await fundedWallet(env.owner, "1");
      await expect(
        env.registry
          .connect(env.agentOwner)
          .registerAgent(op.address, ethers.id("m"), Tier.Bronze, 500, E18(499))
      ).to.be.revertedWithCustomError(env.registry, "BondTooLow");
    });

    it("rejects a reused operator key", async function () {
      const { operator } = await registerAgent(env);
      await expect(
        env.registry
          .connect(env.agentOwner)
          .registerAgent(operator.address, ethers.id("m2"), Tier.Bronze, 500, E18(1000))
      ).to.be.revertedWithCustomError(env.registry, "OperatorInUse");
    });

    it("rejects the None tier", async function () {
      const op = await fundedWallet(env.owner, "1");
      await expect(
        env.registry
          .connect(env.agentOwner)
          .registerAgent(op.address, ethers.id("m"), Tier.None, 500, E18(1000))
      ).to.be.revertedWithCustomError(env.registry, "InvalidParameter");
    });

    it("rotates the operator key without disturbing history", async function () {
      const { agentId, operator } = await registerAgent(env);
      const next = await fundedWallet(env.owner, "1");

      await env.registry.connect(env.agentOwner).rotateOperator(agentId, next.address);

      expect(await env.registry.operatorOf(agentId)).to.equal(next.address);
      expect(await env.registry.agentIdByOperator(operator.address)).to.equal(0);
      expect(await env.registry.agentIdByOperator(next.address)).to.equal(agentId);
    });

    it("only lets the owner rotate", async function () {
      const { agentId } = await registerAgent(env);
      const next = await fundedWallet(env.owner, "1");
      await expect(
        env.registry.connect(env.other).rotateOperator(agentId, next.address)
      ).to.be.revertedWithCustomError(env.registry, "NotAgentOwner");
    });
  });

  describe("credit — reputation multiplies capital, it does not replace it", function () {
    it("prices credit as bond x leverage x tier factor", async function () {
      // Neutral score => 1.0x leverage. The tier factor comes from `effectiveTier`, and a freshly
      // registered agent has demonstrated nothing, so all three sit on Bronze's 0.5x however they
      // introduced themselves. Declaring a tier is free; this is the line where that stops paying.
      const { agentId } = await registerAgent(env, { bond: E18(1000), tier: Tier.Bronze });
      expect(await env.registry.availableCredit(agentId)).to.equal(E18(500));

      const silver = await registerAgent(env, { bond: E18(1000), tier: Tier.Silver });
      expect(await env.registry.availableCredit(silver.agentId)).to.equal(E18(500));

      const gold = await registerAgent(env, { bond: E18(1000), tier: Tier.Gold });
      expect(await env.registry.availableCredit(gold.agentId)).to.equal(E18(500));
    });

    it("pays the declared tier's factor once, and only once, an attestation lands at it", async function () {
      const silver = await registerAgent(env, { bond: E18(1000), tier: Tier.Silver });
      const gold = await registerAgent(env, { bond: E18(1000), tier: Tier.Gold });
      await env.registry.setRouter(env.owner.address);

      // The router records a Silver delivery for each. The Silver agent gets Silver's 1.0x, which
      // is what it declared and has now shown. The Gold agent gets Silver's too and not Gold's:
      // `effectiveTier` is the lesser of declared and demonstrated, so the unproven half of a
      // claim earns nothing until it is proven.
      await env.registry.recordDelivery(silver.agentId, Tier.Silver);
      await env.registry.recordDelivery(gold.agentId, Tier.Silver);
      expect(await env.registry.availableCredit(silver.agentId)).to.equal(E18(1000));
      expect(await env.registry.availableCredit(gold.agentId)).to.equal(E18(1000));

      // And a Gold delivery finishes the job for the one that declared Gold.
      await env.registry.recordDelivery(gold.agentId, Tier.Gold);
      expect(await env.registry.availableCredit(gold.agentId)).to.equal(E18(1500));

      // The ratchet is capped by the declaration, not just floored by history: a Gold attestation
      // credited to an agent that only ever declared Silver still buys Silver. Nothing here can
      // hand an agent more than it asked for.
      await env.registry.recordDelivery(silver.agentId, Tier.Gold);
      expect(await env.registry.availableCredit(silver.agentId)).to.equal(E18(1000));
    });

    it("ratchets demonstratedTier upward only, and reports both fields", async function () {
      const { agentId } = await registerAgent(env, { bond: E18(1000), tier: Tier.Gold });
      await env.registry.setRouter(env.owner.address);

      expect((await env.registry.getProfile(agentId)).tier).to.equal(Tier.Gold);
      expect((await env.registry.getProfile(agentId)).demonstratedTier).to.equal(Tier.None);

      await expect(env.registry.recordDelivery(agentId, Tier.Gold))
        .to.emit(env.registry, "TierDemonstrated")
        .withArgs(agentId, Tier.Gold);
      expect((await env.registry.getProfile(agentId)).demonstratedTier).to.equal(Tier.Gold);

      // A later Bronze delivery does not demote it. The claim the field encodes is "has produced a
      // Gold proof at least once", and that does not stop being true — degradation is the score's
      // job. No event, because nothing moved.
      await expect(env.registry.recordDelivery(agentId, Tier.Bronze)).to.not.emit(
        env.registry,
        "TierDemonstrated"
      );
      expect((await env.registry.getProfile(agentId)).demonstratedTier).to.equal(Tier.Gold);
    });

    it("gives an undemonstrated agent Bronze rather than nothing", async function () {
      // The floor is load-bearing, not generous. At `Tier.None` the factor is zero, so credit is
      // zero, so `reserve` reverts, so the agent can never take a request, so it can never
      // demonstrate anything — the rule would be unsatisfiable for honest agents too. Bronze is
      // the tier whose attestation is an operator signature, which every registered agent can
      // already produce, so granting it unproven concedes nothing.
      const { agentId } = await registerAgent(env, { bond: E18(1000), tier: Tier.Gold });
      expect(await env.registry.effectiveTier(agentId)).to.equal(Tier.Bronze);
      expect(await env.registry.availableCredit(agentId)).to.be.greaterThan(0);
    });

    it("caps leverage at 6x even at a perfect score", async function () {
      expect(await env.registry.leverageBps(10000)).to.equal(60000);
      expect(await env.registry.leverageBps(9499)).to.equal(40000);
      expect(await env.registry.leverageBps(4999)).to.equal(5000);
    });

    it("respects the global notional cap", async function () {
      await env.registry.setLimits(E18(500), E18(1000));
      const { agentId } = await registerAgent(env, { bond: E18(1_000_000), tier: Tier.Gold });
      expect(await env.registry.availableCredit(agentId)).to.equal(E18(1000));
    });

    it("gives zero credit to a deactivated agent", async function () {
      const { agentId } = await registerAgent(env, { bond: E18(1000) });
      await env.registry.connect(env.agentOwner).setActive(agentId, false);
      expect(await env.registry.availableCredit(agentId)).to.equal(0);
    });

    it("bounds a Sybil farm by total capital, not by identity count", async function () {
      // Ten identities at the minimum bond cannot out-borrow one identity with 10x the bond.
      let farmCredit = 0n;
      for (let i = 0; i < 10; i++) {
        const a = await registerAgent(env, { bond: E18(500), tier: Tier.Bronze });
        farmCredit += await env.registry.availableCredit(a.agentId);
      }
      const whale = await registerAgent(env, { bond: E18(5000), tier: Tier.Bronze });
      expect(farmCredit).to.equal(await env.registry.availableCredit(whale.agentId));
    });
  });

  describe("exposure", function () {
    it("only the router may reserve, release or slash", async function () {
      const { agentId } = await registerAgent(env);
      await expect(
        env.registry.connect(env.other).reserve(agentId, E18(1))
      ).to.be.revertedWithCustomError(env.registry, "NotRouter");
      await expect(
        env.registry.connect(env.other).slash(agentId, E18(1), env.other.address, 0)
      ).to.be.revertedWithCustomError(env.registry, "NotRouter");
    });

    it("refuses a reservation beyond the credit limit", async function () {
      const { agentId } = await registerAgent(env, { bond: E18(1000), tier: Tier.Bronze });
      await env.registry.setRouter(env.owner.address);

      await env.registry.reserve(agentId, E18(500));
      await expect(env.registry.reserve(agentId, 1)).to.be.revertedWithCustomError(
        env.registry,
        "CreditExceeded"
      );
    });

    it("frees capacity on release", async function () {
      const { agentId } = await registerAgent(env, { bond: E18(1000), tier: Tier.Bronze });
      await env.registry.setRouter(env.owner.address);

      await env.registry.reserve(agentId, E18(500));
      expect(await env.registry.availableCredit(agentId)).to.equal(0);
      await env.registry.release(agentId, E18(500));
      expect(await env.registry.availableCredit(agentId)).to.equal(E18(500));
    });
  });

  describe("unbonding", function () {
    it("blocks withdrawal until the period elapses", async function () {
      const { agentId } = await registerAgent(env, { bond: E18(1000) });
      await env.registry.connect(env.agentOwner).startUnbonding(agentId, E18(400));

      await expect(
        env.registry.connect(env.agentOwner).withdraw(agentId)
      ).to.be.revertedWithCustomError(env.registry, "UnbondingNotElapsed");

      await increaseTime(21 * DAY + 1);
      const before = await env.token.balanceOf(env.agentOwner.address);
      await env.registry.connect(env.agentOwner).withdraw(agentId);
      expect(await env.token.balanceOf(env.agentOwner.address)).to.equal(before + E18(400));
    });

    it("removes unbonding capital from credit immediately, not at withdrawal", async function () {
      const { agentId } = await registerAgent(env, { bond: E18(2000), tier: Tier.Bronze });
      expect(await env.registry.availableCredit(agentId)).to.equal(E18(1000));

      await env.registry.connect(env.agentOwner).startUnbonding(agentId, E18(1000));
      expect(await env.registry.availableCredit(agentId)).to.equal(E18(500));
    });

    it("refuses to start unbonding that would strand open exposure", async function () {
      const { agentId } = await registerAgent(env, { bond: E18(2000), tier: Tier.Bronze });
      await env.registry.setRouter(env.owner.address);
      await env.registry.reserve(agentId, E18(1000));

      await expect(
        env.registry.connect(env.agentOwner).startUnbonding(agentId, E18(1500))
      ).to.be.revertedWithCustomError(env.registry, "CreditExceeded");
    });

    it("keeps unbonding capital slashable for the whole period", async function () {
      const { agentId } = await registerAgent(env, { bond: E18(1000) });
      await env.registry.setRouter(env.owner.address);
      await env.registry.connect(env.agentOwner).startUnbonding(agentId, E18(1000));

      await increaseTime(20 * DAY);
      await env.registry.slash(agentId, E18(600), env.challenger.address, E18(600));
      expect((await env.registry.getAgent(agentId)).bond).to.equal(E18(400));

      await increaseTime(2 * DAY);
      const before = await env.token.balanceOf(env.agentOwner.address);
      await env.registry.connect(env.agentOwner).withdraw(agentId);
      // Withdrawal is clamped to what survived the slash.
      expect(await env.token.balanceOf(env.agentOwner.address)).to.equal(before + E18(400));
    });
  });

  /**
   * The early exit is a toll on the unbonding period, not a lock-up fee — the period exists so an
   * agent's own outstanding executions can still settle against its bond. These tests therefore
   * split into two kinds: the arithmetic, which is simple, and the *characterisation* of what the
   * toll does and does not deter, which is the part that will matter when someone reprices it.
   */
  describe("early exit", function () {
    it("pays ninety percent to the owner and ten to the treasury", async function () {
      const { agentId } = await registerAgent(env, { bond: E18(1000) });
      await env.registry.connect(env.agentOwner).startUnbonding(agentId, E18(400));

      const ownerBefore = await env.token.balanceOf(env.agentOwner.address);
      const treasuryBefore = await env.token.balanceOf(env.treasury.address);

      await expect(env.registry.connect(env.agentOwner).withdrawEarly(agentId))
        .to.emit(env.registry, "WithdrawnEarly")
        .withArgs(agentId, E18(360), E18(40));

      expect(await env.token.balanceOf(env.agentOwner.address)).to.equal(ownerBefore + E18(360));
      expect(await env.token.balanceOf(env.treasury.address)).to.equal(treasuryBefore + E18(40));
      // The whole unbonding amount leaves the bond; the penalty is a split of it, not a surcharge.
      expect((await env.registry.getAgent(agentId)).bond).to.equal(E18(600));
      expect((await env.registry.getAgent(agentId)).unbondingAmount).to.equal(0);
    });

    it("is exact at six decimals", async function () {
      const six = await deployProtocol({ decimals: 6 });
      await (await six.registry.setLimits(six.units(100), six.units(5_000_000))).wait();
      const { agentId } = await registerAgent(six, { bond: six.units(333.33) });
      await six.registry.connect(six.agentOwner).startUnbonding(agentId, six.units(333.33));

      const before = await six.token.balanceOf(six.treasury.address);
      await six.registry.connect(six.agentOwner).withdrawEarly(agentId);
      // 333.33 USDT is 333_330_000 base units; a tenth is 33_333_000 with nothing left over.
      expect(await six.token.balanceOf(six.treasury.address)).to.equal(before + 33_333_000n);
    });

    it("refuses once the period has elapsed, rather than charging for nothing", async function () {
      const { agentId } = await registerAgent(env, { bond: E18(1000) });
      await env.registry.connect(env.agentOwner).startUnbonding(agentId, E18(400));
      await increaseTime(21 * DAY + 1);

      // There is no longer anything to buy out, and silently taking 10% here would make the free
      // door the one a caller has to know to look for.
      await expect(
        env.registry.connect(env.agentOwner).withdrawEarly(agentId)
      ).to.be.revertedWithCustomError(env.registry, "UnbondingElapsed");
      await env.registry.connect(env.agentOwner).withdraw(agentId);
    });

    it("needs an unbonding to exit from", async function () {
      const { agentId } = await registerAgent(env, { bond: E18(1000) });
      await expect(
        env.registry.connect(env.agentOwner).withdrawEarly(agentId)
      ).to.be.revertedWithCustomError(env.registry, "NothingToWithdraw");
    });

    it("refuses while the agent still has exposure open", async function () {
      const { agentId } = await registerAgent(env, { bond: E18(2000), tier: Tier.Bronze });
      await env.registry.setRouter(env.owner.address);
      await env.registry.reserve(agentId, E18(500));
      // Bronze at NEUTRAL is 0.5x, so E18(1000) of remaining bond backs exactly E18(500) open —
      // the unbonding is legitimate and the *slow* door stays available. Only the fast one closes.
      await env.registry.connect(env.agentOwner).startUnbonding(agentId, E18(1000));

      await expect(
        env.registry.connect(env.agentOwner).withdrawEarly(agentId)
      ).to.be.revertedWithCustomError(env.registry, "OutstandingLiability");

      await increaseTime(21 * DAY + 1);
      const before = await env.token.balanceOf(env.agentOwner.address);
      await env.registry.connect(env.agentOwner).withdraw(agentId);
      expect(await env.token.balanceOf(env.agentOwner.address)).to.equal(before + E18(1000));
    });

    it("opens as soon as the exposure reaches a terminal state", async function () {
      const { agentId } = await registerAgent(env, { bond: E18(2000), tier: Tier.Bronze });
      await env.registry.setRouter(env.owner.address);
      await env.registry.reserve(agentId, E18(500));
      await env.registry.connect(env.agentOwner).startUnbonding(agentId, E18(1000));
      expect((await env.registry.previewWithdrawEarly(agentId)).allowed).to.equal(false);

      // The router releases notional in exactly three places, all of them terminal: _settle,
      // slashUnresolvedChallenge and markExpired. So this single call stands in for every way an
      // execution can end, and there is no fourth way for openNotional to reach zero.
      await env.registry.release(agentId, E18(500));

      const preview = await env.registry.previewWithdrawEarly(agentId);
      expect(preview.allowed).to.equal(true);
      expect(preview.paid).to.equal(E18(900));
      expect(preview.penalty).to.equal(E18(100));
      await env.registry.connect(env.agentOwner).withdrawEarly(agentId);
      expect((await env.registry.getAgent(agentId)).bond).to.equal(E18(1000));
    });

    it("is a toll on churn now, not a price on escaping a fault", async function () {
      const { agentId } = await registerAgent(env, { bond: E18(1000) });
      const faultBps = BigInt(await env.router.faultSlashBps());
      const exitBps = BigInt(await env.registry.earlyExitPenaltyBps());

      // The toll is still smaller than one fault slash, and that is now fine rather than the
      // hole it would otherwise be: an agent cannot reach this door while it has an outcome
      // outstanding, so there is no fault left for the smaller number to buy its way out of.
      // If the openNotional gate above is ever removed, this comparison becomes the bug.
      expect(exitBps).to.equal(1_000n);
      expect(exitBps).to.be.lessThan(faultBps);

      await env.registry.connect(env.agentOwner).startUnbonding(agentId, E18(1000));
      const before = await env.token.balanceOf(env.agentOwner.address);
      await env.registry.connect(env.agentOwner).withdrawEarly(agentId);
      expect((await env.token.balanceOf(env.agentOwner.address)) - before).to.equal(E18(900));
    });

    it("is retunable by the owner and bounded at a hundred percent", async function () {
      await env.registry.setEarlyExitPenaltyBps(3_500);
      expect(await env.registry.earlyExitPenaltyBps()).to.equal(3_500);

      await expect(env.registry.setEarlyExitPenaltyBps(10_001)).to.be.revertedWithCustomError(
        env.registry,
        "InvalidParameter"
      );
      await expect(
        env.registry.connect(env.agentOwner).setEarlyExitPenaltyBps(0)
      ).to.be.revertedWithCustomError(env.registry, "NotOwner");
    });
  });

  describe("slashing", function () {
    beforeEach(async function () {
      await env.registry.setRouter(env.owner.address);
    });

    it("splits between the bounty recipient and the treasury", async function () {
      const { agentId } = await registerAgent(env, { bond: E18(1000) });
      const cBefore = await env.token.balanceOf(env.challenger.address);
      const tBefore = await env.token.balanceOf(env.treasury.address);

      await env.registry.slash(agentId, E18(100), env.challenger.address, E18(40));

      expect(await env.token.balanceOf(env.challenger.address)).to.equal(cBefore + E18(40));
      expect(await env.token.balanceOf(env.treasury.address)).to.equal(tBefore + E18(60));
      expect((await env.registry.getAgent(agentId)).bond).to.equal(E18(900));
    });

    it("clamps to the remaining bond", async function () {
      const { agentId } = await registerAgent(env, { bond: E18(1000) });
      await env.registry.slash(agentId, E18(5000), env.challenger.address, 0);
      expect((await env.registry.getAgent(agentId)).bond).to.equal(0);
    });
  });

  describe("meetsPolicy", function () {
    it("enforces every field independently", async function () {
      const { agentId } = await registerAgent(env, { bond: E18(1000), tier: Tier.Silver });
      const base = {
        minScore: 5000,
        minTier: Tier.Silver,
        maxFaults: 0,
        minBond: E18(1000),
        maxStalenessSeconds: 7 * DAY,
      };

      // `minTier` screens on `effectiveTier`, so declaring Silver is not enough to pass a Silver
      // filter — the agent has to have had a Silver attestation accepted. Until then it reads as
      // Bronze and the base policy rejects it.
      expect(await env.registry.meetsPolicy(agentId, base)).to.equal(false);
      expect(await env.registry.meetsPolicy(agentId, { ...base, minTier: Tier.Bronze })).to.equal(true);

      await env.registry.setRouter(env.owner.address);
      await env.registry.recordDelivery(agentId, Tier.Silver);

      expect(await env.registry.meetsPolicy(agentId, base)).to.equal(true);
      expect(await env.registry.meetsPolicy(agentId, { ...base, minScore: 5001 })).to.equal(false);
      expect(await env.registry.meetsPolicy(agentId, { ...base, minTier: Tier.Gold })).to.equal(false);
      expect(await env.registry.meetsPolicy(agentId, { ...base, minBond: E18(1001) })).to.equal(false);
    });

    it("rejects a stale agent", async function () {
      const { agentId } = await registerAgent(env, { tier: Tier.Silver });
      const policy = {
        minScore: 0,
        minTier: Tier.Bronze,
        maxFaults: 0,
        minBond: 0,
        maxStalenessSeconds: DAY,
      };
      expect(await env.registry.meetsPolicy(agentId, policy)).to.equal(true);
      await increaseTime(2 * DAY);
      expect(await env.registry.meetsPolicy(agentId, policy)).to.equal(false);
    });

    // BOTID-04. `recordFault` used to stamp `lastActiveAt` alongside the score haircut, which
    // made the staleness screen answer the wrong question: a fault is evidence the agent did not
    // do its job, and it was being counted as evidence that it had. The liveness case closed the
    // loop — an agent that had gone dark earns a Liveness fault the moment anyone calls
    // `markExpired`, so the report of its failure was what restored it to eligibility, and
    // `markExpired` is permissionless and pays a bounty. Freshness must survive a fault unchanged.
    it("does not let a fault pass for activity", async function () {
      const { agentId } = await registerAgent(env, { tier: Tier.Silver });
      const policy = {
        minScore: 0,
        minTier: Tier.Bronze,
        maxFaults: 100, // faults themselves are not what this test is about
        minBond: 0,
        maxStalenessSeconds: DAY,
      };

      await increaseTime(2 * DAY);
      expect(await env.registry.meetsPolicy(agentId, policy)).to.equal(false);

      const before = (await env.engine.getStats(agentId)).lastActiveAt;
      await env.engine.setWriter(env.owner.address, true);
      await env.engine.recordFault(agentId, 0); // FaultKind.Liveness

      expect((await env.engine.getStats(agentId)).lastActiveAt).to.equal(before);
      expect(await env.registry.meetsPolicy(agentId, policy)).to.equal(false);
    });

    it("rejects an unknown or deactivated agent", async function () {
      const policy = {
        minScore: 0,
        minTier: Tier.Bronze,
        maxFaults: 100,
        minBond: 0,
        maxStalenessSeconds: 0,
      };
      expect(await env.registry.meetsPolicy(999, policy)).to.equal(false);

      const { agentId } = await registerAgent(env);
      await env.registry.connect(env.agentOwner).setActive(agentId, false);
      expect(await env.registry.meetsPolicy(agentId, policy)).to.equal(false);
    });
  });
});

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { E18, Tier, deployProtocol, registerAgent } = require("./helpers");

const CLEAN = { realizedPnlBps: 0, slaBreached: false, limitBreached: false };
const RUINOUS = { realizedPnlBps: -3000, slaBreached: true, limitBreached: true };
const NEUTRAL = 5_000n;

/** A distinct counterparty address per call. Minting these has always been free; that is the point. */
const counterparty = (i) => ethers.getAddress(`0x${(i + 1).toString(16).padStart(40, "0")}`);

/**
 * Regression suite for the Sybil vector — manufacturing reputation by manufacturing counterparties.
 *
 * `consumerWeightCap` was the protocol's stated answer to "can one customer define an agent's
 * score", and it answers that question correctly. The docstring above it also claimed a high score
 * required "several independent counterparties", and *that* claim had nothing enforcing it:
 * `_budgets` is keyed by address, and an address costs a keypair. A fresh EOA arrived with a fresh
 * full 50,000 of budget, so an attacker who wanted ten times the influence generated ten addresses.
 * The cap was a per-transaction speed limit on someone free to drive more cars.
 *
 * `weightPerFeeUnit` closes it, and it closes it by arithmetic rather than by heuristic: influence
 * is bought with the protocol's cut of the fee, and money does not fork when an address does. The
 * treasury cut is the right thing to price it on because it is the only part of an execution's
 * money flow that does not come back to the payer — notional is reserved and released, and the fee
 * itself goes to the agent, which on a self-dealt execution is the attacker's other pocket.
 *
 * These tests are engine-level rather than router-level for the same reason Calibration.test.js is:
 * the claim is about the arithmetic of `_spend`, and driving the writer directly is the only way to
 * hold every other variable still. The end-to-end control at the bottom checks the router actually
 * passes the cut through.
 */
describe("Sybil griefing — buying a reputation one address at a time", function () {
  let env;

  /** The protocol's cut of a fee posted at the router's floor: `notional / 20_000`. */
  const feeCut = (notional) => notional / 20_000n;

  /** The shipped default for `weightPerFeeUnit`, spelled out so re-arming never reads back a zero. */
  const RATE = 20_000n;

  beforeEach(async function () {
    env = await deployProtocol();
    await env.engine.setWriter(env.owner.address, true);
    await env.engine.initAgent(1);
  });

  /**
   * Lift `consumerWeightCap` clear so `weightPerFeeUnit` is the only ceiling in play.
   *
   * Not a convenience: with both armed, a result could be explained by either, and the whole
   * question here is which of the two survives address-splitting. The per-consumer cap has its own
   * tests, and it is the one the splitting attack was designed to walk around.
   */
  async function onlyVoiceBinds() {
    await env.engine.setParameters(
      await env.engine.halfWeight(),
      await env.engine.weightCap(),
      0n, // disabled
      await env.engine.decayHalfLife(),
      await env.engine.livenessHaircutBps(),
      await env.engine.verificationHaircutBps(),
      RATE // named, not read back: a test that disables it first must still get it re-armed
    );
  }

  describe("voice is bought, not granted", function () {
    it("gives a brand-new address none of it", async function () {
      // The state every Sybil attack starts from. Before the fix this read 50,000e18 — a full
      // budget, handed over for the cost of generating a keypair.
      expect(await env.engine.remainingWeight(1, counterparty(0))).to.equal(0n);
    });

    it("credits exactly protocolFee x weightPerFeeUnit, and only on payment", async function () {
      const rate = await env.engine.weightPerFeeUnit();
      const fee = E18(3);

      // `balance` is the balance after *earning*, not after the report that follows it — the event
      // is emitted from `_earnVoice`, which runs first precisely so this execution's own fee is
      // available to this execution's report.
      await expect(env.engine.recordOutcome(1, counterparty(0), CLEAN, E18(1_000), 500, fee))
        .to.emit(env.engine, "VoiceEarned")
        .withArgs(counterparty(0), fee * rate, fee * rate);

      // The report itself then spent 1,000 of it — the notional, since nothing else bound here.
      // What is left is the difference, and it persists.
      expect(await env.engine.voice(counterparty(0))).to.equal(fee * rate - E18(1_000));
    });

    it("does not decay — the money did not come back, so neither does the entitlement", async function () {
      await env.engine.recordOutcome(1, counterparty(0), CLEAN, E18(1_000), 500, E18(3));
      const held = await env.engine.voice(counterparty(0));

      await ethers.provider.send("evm_increaseTime", [400 * 24 * 3600]);
      await ethers.provider.send("evm_mine", []);

      expect(await env.engine.voice(counterparty(0))).to.equal(held);
    });
  });

  describe("the vector itself", function () {
    it("buys the same total influence however many addresses the spend is split across", async function () {
      await onlyVoiceBinds();

      // One address, one payment. The honest shape.
      const fee = E18(50);
      await env.engine.recordOutcome(1, counterparty(0), CLEAN, E18(500_000), 500, fee);
      const concentrated = await env.engine.getScore(1);

      // The same total fee, split ten ways across ten addresses never seen before, each reporting
      // the same flawless outcome at the same notional. This is the attack, and before the fix each
      // of these arrived with its own full budget for free.
      await env.engine.initAgent(2);
      let splitEarned = 0n;
      for (let i = 0; i < 10; i += 1) {
        await env.engine.recordOutcome(2, counterparty(100 + i), CLEAN, E18(500_000), 500, fee / 10n);
        splitEarned += (fee / 10n) * RATE;
      }
      const split = await env.engine.getScore(2);

      // The invariant the fix establishes: influence is bought, the price is linear in the fee, and
      // the fee is equal — so the two shapes are issued the *same total influence*. Splitting the
      // payer no longer changes the size of the budget, which is the axis that used to be free.
      expect(splitEarned).to.equal(fee * RATE);

      // What that does not buy is equal scores, and the reason is worth being exact about rather
      // than glossing. Two separate effects pull apart here.
      //
      // First, one report can only absorb its own notional: the concentrated payer bought
      // 1,000,000 of voice and a single 500,000 execution could spend half of it. The rest is not
      // forfeited — `voice` is a balance, not a rate — so it is still there to spend, which the
      // assertions below check rather than assume.
      const held = await env.engine.voice(counterparty(0));
      expect(held).to.equal(fee * RATE - E18(500_000));

      // Second, and this is the residual: the EWMA moves a fraction of the *remaining* distance, so
      // ten half-steps land nearer the target than one ten-times-larger step — 9,995 against 9,166.
      // Fragmenting a paid budget still helps a little. It is a far smaller lever than the one it
      // replaces, and it is not free: the next test measures the same swarm paying nothing, which
      // is what the old rule allowed. The axis closed here is "reputation is free", not "the EWMA
      // is linear in weight", and the second was never claimed.
      expect(split).to.be.greaterThan(concentrated);
      expect(split).to.be.lessThan(10_000n);

      // And the remainder really is spendable, so the concentrated payer is behind on this round
      // only, not out of pocket.
      await env.engine.recordOutcome(1, counterparty(0), CLEAN, held, 500, 0);
      expect(await env.engine.voice(counterparty(0))).to.equal(0n);
      expect(await env.engine.getScore(1)).to.be.greaterThan(concentrated);
    });

    it("charges for the fragmentation that used to be free", async function () {
      // The measurement the test above defers to. Same ten fresh addresses, same flawless reports,
      // same notional — the only difference is whether influence has to be paid for.
      const swarm = async (agentId, fee) => {
        await env.engine.initAgent(agentId);
        for (let i = 0; i < 10; i += 1) {
          await env.engine.recordOutcome(agentId, counterparty(400 + agentId * 20 + i), CLEAN, E18(500_000), 500, fee);
        }
        return env.engine.getScore(agentId);
      };

      // Disabled: the pre-fix rule. Ten free keypairs, nothing paid, near-perfect score.
      await env.engine.setParameters(
        await env.engine.halfWeight(),
        await env.engine.weightCap(),
        0n,
        await env.engine.decayHalfLife(),
        await env.engine.livenessHaircutBps(),
        await env.engine.verificationHaircutBps(),
        0n
      );
      expect(await swarm(2, 0n)).to.be.greaterThan(9_900n);

      // Armed: the same swarm, still paying nothing, buys exactly nothing.
      await onlyVoiceBinds();
      expect(await swarm(3, 0n)).to.equal(NEUTRAL);
    });

    it("leaves a self-dealing agent's credit line where it found it", async function () {
      await onlyVoiceBinds();
      const before = await env.registry.availableCredit(1);

      // Twenty rounds of a fabricated flawless history, a fresh consumer address for each, all of
      // them paying nothing — which is what a self-dealt execution costs once you notice the fee
      // returns to the same party. Under the old rule this was the whole attack and it worked.
      for (let i = 0; i < 20; i += 1) {
        await env.engine.recordOutcome(1, counterparty(200 + i), CLEAN, E18(500_000), 500, 0);
      }

      expect(await env.engine.getScore(1)).to.equal(NEUTRAL);
      expect(await env.registry.availableCredit(1)).to.equal(before);
    });

    it("bounds the damage a Sybil swarm can do in the other direction too", async function () {
      await onlyVoiceBinds();

      // Symmetric on purpose. The cheap way to *destroy* a competitor was the same trick with the
      // outcome inverted, and it needed no relationship with the agent beyond a settled request.
      for (let i = 0; i < 20; i += 1) {
        await env.engine.recordOutcome(1, counterparty(300 + i), RUINOUS, E18(500_000), 500, 0);
      }

      expect(await env.engine.getScore(1)).to.equal(NEUTRAL);
    });
  });

  describe("what it must not break", function () {
    it("never throttles a consumer paying the fee floor", async function () {
      await onlyVoiceBinds();

      // The calibration that makes the default safe to ship: `minFeeBps` 10 of notional, then
      // `protocolFeeBps` 500 of that, is `notional / 20_000`, and at a rate of 20,000 that buys
      // back exactly `notional` of voice. So an honest consumer transacting at the minimum has
      // precisely enough for its own report, every time, at any size.
      const notional = E18(400_000);
      await env.engine.recordOutcome(1, counterparty(0), CLEAN, notional, 500, feeCut(notional));

      // Uncapped, a 400,000 notional against a halfWeight of 100,000 weighs 80% of the distance
      // to a perfect score. Anything less would mean the Sybil bound had clipped an honest report.
      expect(await env.engine.getScore(1)).to.equal(9_000n);
      expect(await env.engine.voice(counterparty(0))).to.equal(0n);
    });

    it("is disabled outright at zero, leaving the old behaviour intact", async function () {
      await env.engine.setParameters(
        await env.engine.halfWeight(),
        await env.engine.weightCap(),
        0n,
        await env.engine.decayHalfLife(),
        await env.engine.livenessHaircutBps(),
        await env.engine.verificationHaircutBps(),
        0n
      );

      // No fee, no voice, and the report still lands in full. Governance keeps the escape hatch.
      await env.engine.recordOutcome(1, counterparty(0), CLEAN, E18(400_000), 500, 0);
      expect(await env.engine.getScore(1)).to.equal(9_000n);
      expect(await env.engine.remainingWeight(1, counterparty(0))).to.equal(ethers.MaxUint256);
    });

    it("does not let the per-agent budget bill voice it then discards", async function () {
      // The ordering trap `_spend` is written around. Both ceilings are measured before either is
      // charged; clamping and debiting one at a time would bill the looser for weight the tighter
      // was about to throw away. Here the per-agent budget is nearly exhausted, so this report is
      // worth almost nothing — and it must cost almost nothing, or a griefer could drain a
      // consumer's paid-for voice with reports that move no score.
      const cap = await env.engine.consumerWeightCap();
      const who = counterparty(0);

      // Buy a large balance, and spend the per-agent budget down to nothing on agent 1.
      await env.engine.recordOutcome(1, who, CLEAN, cap, 500, E18(1_000));
      const afterFirst = await env.engine.voice(who);
      expect(afterFirst).to.be.greaterThan(0n);

      // A second, enormous report on the same agent. The budget clamps it to ~0.
      await env.engine.recordOutcome(1, who, CLEAN, E18(5_000_000), 500, 0);

      // So the voice balance is essentially untouched — and, crucially, still spendable on a
      // different agent, which is what makes the two ceilings independent rather than nested.
      expect(await env.engine.voice(who)).to.be.closeTo(afterFirst, afterFirst / 1000n);
      await env.engine.initAgent(3);
      await env.engine.recordOutcome(3, who, CLEAN, afterFirst, 500, 0);
      expect(await env.engine.getScore(3)).to.be.greaterThan(NEUTRAL);
    });
  });

  describe("end to end", function () {
    it("passes the router's treasury cut through to the consumer's balance", async function () {
      // Everything above drives the engine directly. This pins the one thing that cannot: that
      // `_settle` computes the protocol cut before recording the outcome and hands the engine the
      // same number it sends the treasury. A fee that reached the treasury but not the engine
      // would leave honest consumers mute for reasons no test above could see.
      //
      // A fresh protocol, because the suite's `beforeEach` hand-initialises agent 1 to drive the
      // engine directly and `registerAgent` would collide with it.
      const env = await deployProtocol();
      const agent = await registerAgent(env, { tier: Tier.Bronze, bond: E18(1_000_000) });
      const notional = E18(100_000);
      const fee = (notional * (await env.router.minFeeBps())) / 10_000n;
      const rate = await env.engine.weightPerFeeUnit();
      const cut = (fee * (await env.router.protocolFeeBps())) / 10_000n;

      const before = await env.engine.voice(env.consumer.address);
      const treasuryBefore = await env.token.balanceOf(env.treasury.address);

      const { requestId } = await commissionAndSettle(env, agent, notional, fee);
      expect(requestId).to.not.equal(ethers.ZeroHash);

      // The treasury got `cut`, and the consumer's voice moved by `cut * rate` less whatever this
      // execution's own report spent. Both sides of that come from the same local.
      expect((await env.token.balanceOf(env.treasury.address)) - treasuryBefore).to.equal(cut);
      const earned = cut * rate;
      const spent = earned - ((await env.engine.voice(env.consumer.address)) - before);
      expect(spent).to.be.greaterThan(0n);
      expect(spent).to.be.at.most(earned);
    });
  });
});

/**
 * Order, deliver, finalize and settle one Bronze execution as `env.consumer`.
 *
 * Local to this file rather than lifted into helpers: it is the shortest happy path and it exists
 * only so the end-to-end test above can assert on the money, not because anything else needs it.
 */
async function commissionAndSettle(env, agent, notional, fee) {
  const {
    now,
    increaseTime,
    signDigest,
    executionDigest,
    buildBundle,
    commitOutputs,
  } = require("./helpers");

  const ts = await now();
  const { bundle, commitment } = buildBundle(
    env.chainId,
    env.attestor.target,
    [{ feedId: ethers.id("BOT/USD"), value: 12_500n, salt: ethers.id("salt-sybil"), timestamp: ts }],
    [env.publisher]
  );
  const deliverBy = ts + 3600;

  const tx = await env.router
    .connect(env.consumer)
    .requestExecution(agent.agentId, commitment, notional, fee, deliverBy, "");
  const receipt = await tx.wait();
  const requestId = receipt.logs
    .map((l) => {
      try {
        return env.router.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((e) => e && e.name === "ExecutionRequested").args.requestId;

  const outputs = [3300n, 6700n];
  const outCommitment = commitOutputs(outputs);
  const sig = signDigest(
    agent.operator,
    executionDigest(env.chainId, env.sigAdapter.target, {
      requestId,
      agentId: agent.agentId,
      modelCommitment: agent.model,
      inputCommitment: commitment,
      outputCommitment: outCommitment,
      deliverBy,
    })
  );
  await env.router.connect(agent.operator).deliver(requestId, outCommitment, bundle, sig);
  await increaseTime(2 * 3600);
  await env.router.finalize(requestId);
  await env.router.connect(env.consumer).settle(requestId, CLEAN);
  return { requestId };
}

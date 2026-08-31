const { expect } = require("chai");
const { ethers } = require("hardhat");
const { Tier, deployProtocol, registerAgent } = require("./helpers");

/**
 * These tests are about the *values* deploy.js ships, not about whether the mechanism is correct.
 * Everything else in the suite asks whether the EWMA does what an EWMA should do; this asks
 * whether the numbers we feed it describe the protocol we actually built.
 *
 * The question that motivates it: MIN_BOND is $100, and an agent bonding exactly that is the
 * smallest participant the protocol admits. Does the scoring engine have anything to say about
 * such an agent, or does it round it to nothing? A reputation system whose smallest members can
 * never accumulate reputation has a floor that is decorative — the door is open and the corridor
 * behind it goes nowhere.
 *
 * The arithmetic is not obvious from any single parameter, which is why it is asserted rather
 * than argued. Credit is bond x leverage(score) x tierFactor, so the $100 floor agent is bounded
 * three times over before it ever reaches HALF_WEIGHT.
 */
describe("parameter calibration", () => {
  const NEUTRAL = 5_000n;
  const CLEAN = { realizedPnlBps: 0, slaBreached: false, limitBreached: false };

  /** deploy.js's CAPITAL_DEFAULTS, in whole tokens. Kept in step with it by hand. */
  const DEFAULTS = { halfWeight: 1_000, weightCap: 10_000, minBond: 100, globalCap: 5_000_000 };

  /**
   * A distinct counterparty per delivery. `consumerWeightCap` bounds how much any one of them can
   * move a score, so an agent's ramp is a question about a market rather than about a single
   * customer — which is what these tests are measuring. Addresses only; nothing is signed.
   */
  const counterparty = (i) => ethers.getAddress(`0x${(i + 1).toString(16).padStart(40, "0")}`);

  /**
   * The protocol's cut of a fee posted at the router's floor — which is what `recordOutcome` now
   * prices a consumer's influence in.
   *
   * `minFeeBps` is 10 of the notional and `protocolFeeBps` is 500 of that, so the cut is
   * `notional / 20_000`; at the default `weightPerFeeUnit` of 20,000 it buys back exactly
   * `notional` of voice. That break-even is the point of the default, and it is why every number
   * below is unchanged: a consumer paying the fee floor is never the binding ceiling, so these
   * tests still measure the parameters they were written to measure rather than the Sybil bound.
   */
  const feeCut = (notional) => notional / 20_000n;

  async function calibrated(
    env,
    { halfWeight = DEFAULTS.halfWeight, consumerWeightCap = halfWeight / 2 } = {}
  ) {
    const whole = (n) => ethers.parseUnits(String(n), env.decimals);
    await (
      await env.engine.setParameters(
        whole(halfWeight),
        whole(DEFAULTS.weightCap),
        whole(consumerWeightCap),
        await env.engine.decayHalfLife(),
        await env.engine.livenessHaircutBps(),
        await env.engine.verificationHaircutBps(),
        await env.engine.weightPerFeeUnit()
      )
    ).wait();
    await (await env.registry.setLimits(whole(DEFAULTS.minBond), whole(DEFAULTS.globalCap))).wait();
  }

  it("gives the minimum-bond agent a credit line of fifty dollars", async () => {
    const env = await deployProtocol({ decimals: 6 });
    await calibrated(env);

    const { agentId } = await registerAgent(env, {
      tier: Tier.Bronze,
      bond: env.units(DEFAULTS.minBond),
    });

    // $100 bond, NEUTRAL score so leverage is 1.0x, Bronze multiplies by 0.5x. Nothing this agent
    // executes can exceed this, which is what makes it the right yardstick for HALF_WEIGHT.
    const profile = await env.registry.getProfile(agentId);
    expect(profile.maxOpenNotional).to.equal(env.units(50));
    expect(profile.score).to.equal(NEUTRAL);
  });

  it("lets that agent earn its way to the 2.0x band in a plausible number of deliveries", async () => {
    const env = await deployProtocol({ decimals: 6 });
    await calibrated(env);
    await (await env.engine.setWriter(env.owner.address, true)).wait();
    await (await env.engine.initAgent(1)).wait();

    // Executions at the agent's full $50 ceiling, each one clean and in spec, each for a different
    // customer.
    let n = 0;
    while ((await env.engine.getScore(1)) < 7_000n && n < 100) {
      await (
        await env.engine.recordOutcome(1, counterparty(n), CLEAN, env.units(50), 500, feeCut(env.units(50)))
      ).wait();
      n += 1;
    }

    // 7000 is where leverageBps steps from 1.0x to 2.0x, so this is the moment the agent's credit
    // line doubles and the ramp starts accelerating on its own. Eleven is what the arithmetic
    // gives: a weight of 50/1050, or 4.8% of the distance to a perfect score each time.
    expect(n).to.equal(11);
    expect(await env.registry.leverageBps(await env.engine.getScore(1))).to.equal(20_000n);
  });

  it("would have left that agent stranded at the old half weight", async () => {
    const env = await deployProtocol({ decimals: 6 });
    await calibrated(env, { halfWeight: 100_000 });
    await (await env.engine.setWriter(env.owner.address, true)).wait();
    await (await env.engine.initAgent(1)).wait();

    // The same fifty clean deliveries, against the parameter as it was before this repricing.
    for (let i = 0; i < 50; i += 1) {
      await (
        await env.engine.recordOutcome(1, counterparty(i), CLEAN, env.units(50), 500, feeCut(env.units(50)))
      ).wait();
    }

    // A weight of 50/100050 per delivery — about 0.05%. Fifty flawless executions move the score
    // by less than one percent of the way to the next band, and the agent stays on 1.0x leverage
    // forever: it cannot earn the score that unlocks the capital that would let it earn the
    // score. Nothing reverts and nothing looks wrong, which is the point.
    const score = await env.engine.getScore(1);
    expect(score).to.be.lessThan(6_200n);
    expect(await env.registry.leverageBps(score)).to.equal(10_000n);
  });

  it("caps a single execution below a total overwrite of history", async () => {
    const env = await deployProtocol({ decimals: 6 });
    // The per-consumer budget is lifted clear here so that WEIGHT_CAP is the only thing binding —
    // this test is about that parameter alone. The test below is about the other one.
    await calibrated(env, { consumerWeightCap: 1_000_000 });
    await (await env.engine.setWriter(env.owner.address, true)).wait();
    await (await env.engine.initAgent(1)).wait();

    // An execution far above WEIGHT_CAP, so the weight is the cap rather than the notional:
    // 10,000/11,000, or 91% of the distance. Large, deliberately — capital-weighted reputation
    // means a big well-executed delivery should count for more — but not the whole story.
    await (
      await env.engine.recordOutcome(1, counterparty(0), CLEAN, env.units(5_000_000), 500, feeCut(env.units(5_000_000)))
    ).wait();

    const score = await env.engine.getScore(1);
    expect(score).to.be.greaterThan(9_500n);
    expect(score).to.be.lessThan(10_000n);
  });

  it("caps a single counterparty below a total overwrite of history", async () => {
    const env = await deployProtocol({ decimals: 6 });
    await calibrated(env);
    await (await env.engine.setWriter(env.owner.address, true)).wait();
    await (await env.engine.initAgent(1)).wait();

    // The same execution, at the calibrated per-consumer budget of 500 rather than a lifted one.
    // WEIGHT_CAP would let this weigh 10,000; the budget lets it weigh 500, or a third of the
    // distance. The same arithmetic runs in reverse for a *false* report, which is the reason the
    // parameter exists: `settle` takes the consumer's word for the outcome, and the damage of a
    // lie scales with a notional the liar picks while the cost is a fraction of it.
    await (
      await env.engine.recordOutcome(1, counterparty(0), CLEAN, env.units(5_000_000), 500, feeCut(env.units(5_000_000)))
    ).wait();
    expect(await env.engine.getScore(1)).to.equal(6_666n);

    // And a second report from the same counterparty, however large, is now almost mute: the
    // budget is spent and refills only on the 90-day half-life.
    await (
      await env.engine.recordOutcome(1, counterparty(0), CLEAN, env.units(5_000_000), 500, feeCut(env.units(5_000_000)))
    ).wait();
    expect(await env.engine.getScore(1)).to.equal(6_666n);
    expect(await env.engine.remainingWeight(1, counterparty(0))).to.equal(0n);

    // A different customer's *budget* is untouched — the per-consumer cap is keyed by address, so
    // reputation still aggregates across counterparties. What `remainingWeight` reports for it is
    // nonetheless zero, and that is the Sybil bound showing through rather than a regression: the
    // two ceilings are independent, the reported figure is the lesser, and a counterparty that has
    // never paid a fee has bought no voice with which to spend its budget. Minting the address was
    // always free; this is the line where that stops being enough.
    expect(await env.engine.remainingWeight(1, counterparty(1))).to.equal(0n);

    // Pay, and the aggregation is real rather than merely budgeted: the score moves again on a
    // report the first counterparty could no longer have made at any size.
    await (
      await env.engine.recordOutcome(
        1,
        counterparty(1),
        CLEAN,
        env.units(5_000_000),
        500,
        feeCut(env.units(5_000_000))
      )
    ).wait();
    expect(await env.engine.getScore(1)).to.be.greaterThan(6_666n);
  });
});

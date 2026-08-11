const { expect } = require("chai");
const { ethers } = require("hardhat");
const { Tier, deployProtocol, registerAgent } = require("./helpers");

/**
 * The bond token is USDT at six decimals, and every other test in this suite runs at eighteen.
 *
 * Nothing in the contracts is decimal-aware — ScoreMath is basis points end to end, and transfers
 * move whatever units the token uses. What is decimal-aware is five *parameters*, each carrying a
 * magnitude in bond-token units and each initialised at 18 decimals in storage. Deploying against
 * USDT without rescaling them leaves the protocol off by a factor of 10^12 in five places.
 *
 * The reason that deserves its own file is that the five do not fail alike. Two of them throw the
 * moment anyone tries anything, which is the good case — you learn in the first minute. The other
 * two produce a protocol that runs, settles, emits events and renders a calm dashboard while
 * doing nothing at all. A scoring engine whose scores never move looks exactly like a scoring
 * engine watching well-behaved agents.
 *
 * So these tests are written in two halves: the first pins the broken state precisely enough that
 * the silence is visible, and the second proves the rescale deploy.js performs actually restores
 * the behaviour. The first half is not testing a bug to be fixed — it is testing that the trap is
 * where we think it is, so that the second half means something.
 */
describe("bond token decimals", () => {
  const NEUTRAL = 5_000n;
  // A delivery that went badly in every way the protocol can observe: a 4% loss against a 5%
  // tolerance is survivable on its own, so the two breaches are what make the quality clearly
  // bad rather than marginal. A marginal outcome would leave the "score did not move" assertion
  // unable to distinguish a broken weight from a genuinely unremarkable execution.
  const BAD = { realizedPnlBps: -400, slaBreached: true, limitBreached: true };

  it("mints a token at the decimals it was asked for", async () => {
    const env = await deployProtocol({ decimals: 6 });
    expect(await env.token.decimals()).to.equal(6);
    // Ten million USDT, not ten million ether-scaled units.
    expect(await env.token.balanceOf(env.agentOwner.address)).to.equal(10_000_000_000_000n);
  });

  describe("with 18-decimal parameters still in storage", () => {
    it("prices registration out of reach — the failure that announces itself", async () => {
      const env = await deployProtocol({ decimals: 6 });
      // The storage initialiser is 500e18, and it is a different number from deploy.js's
      // MIN_BOND default of 100 — deliberately, and not worth reconciling: the initialiser is
      // 18-decimal legacy that a real deploy always overwrites, so making it 100e18 would only
      // make a wrong value look intentional. Against a 6-decimal token it reads as 500 trillion
      // USDT, roughly five thousand times the token's entire supply.
      expect(await env.registry.minBond()).to.equal(ethers.parseUnits("500", 18));
      await expect(
        registerAgent(env, { bond: env.units(1_000_000) })
      ).to.be.revertedWithCustomError(env.registry, "BondTooLow");
    });

    it("freezes the score under a full-size execution — the failure that does not", async () => {
      const env = await deployProtocol({ decimals: 6 });
      // Driving the engine directly rather than through the router, because registration is
      // already unreachable above: the point is that even if an agent somehow existed, its
      // executions would carry no weight.
      await (await env.engine.setWriter(env.owner.address, true)).wait();
      await (await env.engine.initAgent(1)).wait();
      expect(await env.engine.getScore(1)).to.equal(NEUTRAL);

      // Three hundred thousand USDT is a large trade by any reading of the parameters. The EWMA
      // weights it as w/(w + halfWeight) — here 3e11 against 1e23, about one part in 10^12.
      await (await env.engine.recordOutcome(1, BAD, env.units(300_000), 500)).wait();

      expect(await env.engine.getScore(1)).to.equal(NEUTRAL);
      // And the execution was recorded, which is what makes this quiet rather than obvious: the
      // counter advances, the event fires, the score does not move.
      const stats = await env.engine.getStats(1);
      expect(stats.settledExecutions ?? stats[1]).to.not.equal(0n);
    });

    it("prices challenges out of reach, removing optimistic security in silence", async () => {
      const env = await deployProtocol({ decimals: 6 });
      const bond = await env.router.challengeBondAmount();
      const supply = await env.token.totalSupply();
      // Nobody can post one, so Bronze and Silver quietly stop being challengeable — and being
      // challengeable is the only thing that makes them honest. Nothing reverts until someone
      // actually tries, and if nobody tries, nothing reverts at all.
      expect(bond).to.be.greaterThan(supply);
    });
  });

  describe("after the rescale deploy.js performs", () => {
    /** The five parameters, derived from whole-token amounts exactly as deploy.js derives them. */
    async function rescale(env) {
      const whole = (n) => ethers.parseUnits(String(n), env.decimals);
      // Every non-magnitude field is read back and passed through unchanged. deploy.js does the
      // same, and for the same reason: these are single setters covering both the parameters that
      // carry token units and the ones that do not, so rescaling means rewriting a struct rather
      // than editing a field. Anything not read back here would silently revert to its default.
      await (
        await env.engine.setParameters(
          whole(1_000),
          whole(10_000),
          await env.engine.decayHalfLife(),
          await env.engine.livenessHaircutBps(),
          await env.engine.verificationHaircutBps()
        )
      ).wait();
      await (await env.registry.setLimits(whole(100), whole(5_000_000))).wait();
      await (
        await env.router.setParameters(
          await env.router.challengeWindow(),
          await env.router.escalationWindow(),
          await env.router.settlementWindow(),
          whole(50),
          await env.router.faultSlashBps(),
          await env.router.livenessSlashBps(),
          await env.router.challengerBountyBps(),
          await env.router.protocolFeeBps()
        )
      ).wait();
    }

    it("lets an agent register at one hundred USDT", async () => {
      const env = await deployProtocol({ decimals: 6 });
      await rescale(env);
      expect(await env.registry.minBond()).to.equal(100_000_000n);

      const { agentId } = await registerAgent(env, {
        tier: Tier.Bronze,
        bond: env.units(1_000_000),
      });
      expect(agentId).to.equal(1n);
      expect(await env.engine.getScore(agentId)).to.equal(NEUTRAL);
    });

    it("moves the score on the execution that previously did nothing", async () => {
      const env = await deployProtocol({ decimals: 6 });
      await rescale(env);
      await (await env.engine.setWriter(env.owner.address, true)).wait();
      await (await env.engine.initAgent(1)).wait();

      await (await env.engine.recordOutcome(1, BAD, env.units(300_000), 500)).wait();

      // Same outcome, same notional, same contract — only the parameters changed. The notional is
      // far above weightCap, so it weighs in at the cap: 10,000 against a halfWeight of 1,000, or
      // 91% of the distance. A bad delivery of this size should take a large bite out of a
      // neutral score rather than a twelve-decimal-places bite.
      const score = await env.engine.getScore(1);
      expect(score).to.be.lessThan(NEUTRAL - 1_000n);
    });

    it("brings the challenge bond back to fifty USDT", async () => {
      const env = await deployProtocol({ decimals: 6 });
      await rescale(env);
      expect(await env.router.challengeBondAmount()).to.equal(50_000_000n);
      // Affordable against a normal balance, which is the whole point — a challenge bond is meant
      // to deter frivolous disputes, not to price out honest ones.
      expect(await env.token.balanceOf(env.challenger.address)).to.be.greaterThan(
        await env.router.challengeBondAmount()
      );
    });
  });

  it("leaves the 18-decimal path untouched", async () => {
    // The suite's default fixture, asserted explicitly so that a future change to the mock's
    // decimals cannot quietly move every other test in the repository onto a different token.
    const env = await deployProtocol();
    expect(await env.token.decimals()).to.equal(18);
    expect(await env.registry.minBond()).to.equal(ethers.parseUnits("500", 18));
  });
});

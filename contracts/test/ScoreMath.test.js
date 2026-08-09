const { expect } = require("chai");
const { ethers } = require("hardhat");
const { E18 } = require("./helpers");

const NEUTRAL = 5000;
const DAY = 24 * 60 * 60;

describe("ScoreMath", function () {
  let m;

  before(async function () {
    m = await (await ethers.getContractFactory("ScoreMathHarness")).deploy();
  });

  describe("decay", function () {
    it("halves the distance from neutral over one half-life", async function () {
      expect(await m.decay(9000, 90 * DAY, 90 * DAY)).to.equal(NEUTRAL + 2000);
      expect(await m.decay(1000, 90 * DAY, 90 * DAY)).to.equal(NEUTRAL - 2000);
    });

    it("is a no-op at zero elapsed time and at neutral", async function () {
      expect(await m.decay(9000, 0, 90 * DAY)).to.equal(9000);
      expect(await m.decay(NEUTRAL, 365 * DAY, 90 * DAY)).to.equal(NEUTRAL);
    });

    it("converges to neutral rather than overshooting", async function () {
      expect(await m.decay(10000, 100 * 365 * DAY, 90 * DAY)).to.equal(NEUTRAL);
      expect(await m.decay(0, 100 * 365 * DAY, 90 * DAY)).to.equal(NEUTRAL);
    });

    it("is monotonic in elapsed time", async function () {
      let prev = 10000;
      for (let d = 0; d <= 360; d += 30) {
        const s = Number(await m.decay(10000, d * DAY, 90 * DAY));
        expect(s).to.be.at.most(prev);
        expect(s).to.be.at.least(NEUTRAL);
        prev = s;
      }
    });

    it("interpolates within a partial half-life", async function () {
      const half = Number(await m.decay(9000, 45 * DAY, 90 * DAY));
      expect(half).to.be.below(9000);
      expect(half).to.be.above(NEUTRAL + 2000);
    });
  });

  describe("observe — anti-grinding", function () {
    const halfWeight = E18(100_000);

    it("moves the score halfway to quality at exactly the half-weight notional", async function () {
      expect(await m.observe(NEUTRAL, 10000, halfWeight, halfWeight)).to.equal(7500);
    });

    it("barely moves on dust", async function () {
      const after = Number(await m.observe(NEUTRAL, 10000, E18(1), halfWeight));
      expect(after - NEUTRAL).to.be.at.most(1);
    });

    it("cannot be ground upward by volume of dust the way a flat +10 could", async function () {
      // The v0 design added a fixed +10 per execution, so 500 dust calls reached the cap.
      let score = NEUTRAL;
      for (let i = 0; i < 500; i++) {
        score = Number(await m.observe(score, 10000, E18(1), halfWeight));
      }
      expect(score).to.be.below(5150);
    });

    it("gives a large execution far more weight than many small ones", async function () {
      const big = Number(await m.observe(NEUTRAL, 10000, E18(500_000), halfWeight));
      let small = NEUTRAL;
      for (let i = 0; i < 20; i++) {
        small = Number(await m.observe(small, 10000, E18(100), halfWeight));
      }
      expect(big).to.be.above(8000);
      expect(small).to.be.below(5100);
    });

    it("is a no-op at zero weight", async function () {
      expect(await m.observe(7000, 0, 0, halfWeight)).to.equal(7000);
    });

    it("moves downward symmetrically for poor quality", async function () {
      expect(await m.observe(9000, 1000, halfWeight, halfWeight)).to.equal(5000);
    });

    it("never leaves the 0..10000 range", async function () {
      expect(await m.observe(0, 10000, E18(10_000_000), halfWeight)).to.be.at.most(10000);
      expect(await m.observe(10000, 0, E18(10_000_000), halfWeight)).to.be.at.least(0);
    });
  });

  describe("haircut", function () {
    it("scales multiplicatively", async function () {
      expect(await m.haircut(10000, 1500)).to.equal(8500);
      expect(await m.haircut(8000, 6000)).to.equal(3200);
    });

    it("zeroes at or above 100%", async function () {
      expect(await m.haircut(9999, 10000)).to.equal(0);
    });
  });

  describe("quality", function () {
    const clean = { realizedPnlBps: 0, slaBreached: false, limitBreached: false };

    it("gives full marks to a clean in-spec execution", async function () {
      expect(await m.quality(clean, 500)).to.equal(10000);
    });

    it("does not reward profit — adherence is what is scored, not returns", async function () {
      const profitable = { ...clean, realizedPnlBps: 5000 };
      expect(await m.quality(profitable, 500)).to.equal(10000);
    });

    it("ignores losses inside the declared tolerance", async function () {
      expect(await m.quality({ ...clean, realizedPnlBps: -400 }, 500)).to.equal(10000);
      expect(await m.quality({ ...clean, realizedPnlBps: -500 }, 500)).to.equal(10000);
    });

    it("penalises losses beyond tolerance, in proportion to the excess", async function () {
      const mild = Number(await m.quality({ ...clean, realizedPnlBps: -750 }, 500));
      const worse = Number(await m.quality({ ...clean, realizedPnlBps: -1000 }, 500));
      expect(mild).to.be.below(10000).and.above(worse);
      expect(worse).to.be.at.most(5100);
    });

    it("bottoms out rather than underflowing on catastrophic loss", async function () {
      expect(await m.quality({ ...clean, realizedPnlBps: -10000 }, 500)).to.equal(0);
    });

    it("halves on an SLA breach and is severe on a limit breach", async function () {
      expect(await m.quality({ ...clean, slaBreached: true }, 500)).to.equal(5000);
      expect(await m.quality({ ...clean, limitBreached: true }, 500)).to.equal(2000);
    });

    it("compounds breaches", async function () {
      const both = { ...clean, slaBreached: true, limitBreached: true };
      expect(await m.quality(both, 500)).to.equal(1000);
    });

    it("treats any loss as out of tolerance when tolerance is zero", async function () {
      expect(await m.quality({ ...clean, realizedPnlBps: -1 }, 0)).to.equal(0);
    });
  });
});

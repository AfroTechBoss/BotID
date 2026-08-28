const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployProtocol, now, Tier } = require("./helpers");

const DAY = 24 * 60 * 60;
const DELAY = 21 * DAY;
const GRACE = 14 * DAY;

/**
 * Mine the next block at an exact timestamp.
 *
 * `increaseTime` is fine when a test only needs "much later", but every assertion here is about a
 * boundary — one second before the eta, exactly on it, one second past the grace window. Nudging
 * the clock forward and hoping the following block lands where intended tests arithmetic about
 * Hardhat rather than arithmetic about the timelock.
 */
async function at(timestamp) {
  await ethers.provider.send("evm_setNextBlockTimestamp", [Number(timestamp)]);
}

/**
 * The notice period on the setters that can redirect trust.
 *
 * The audit's complaint was not that the owner holds these powers — someone has to — but that it
 * could exercise them between two blocks, faster than anyone affected could react, and for two of
 * them without emitting anything at all. What follows checks both halves: that the delay is real
 * and cannot be short-circuited, and that each of these changes now announces itself twice, once
 * when it is queued and once when it lands.
 */
describe("admin timelock", () => {
  let env;

  beforeEach(async () => {
    env = await deployProtocol({ bootstrapped: true });
  });

  const freshEngine = async () =>
    (await ethers.getContractFactory("ReputationEngine")).deploy(env.owner.address);

  describe("bootstrap", () => {
    /**
     * Wiring a protocol takes six calls that all have to land before anything works, so the
     * window has to exist. That it is one-way is the entire guarantee.
     */
    it("is one-way", async () => {
      expect(await env.registry.bootstrapped()).to.equal(true);
      await expect(env.registry.finalizeBootstrap()).to.be.revertedWithCustomError(
        env.registry,
        "AlreadyBootstrapped"
      );
    });

    it("is owner-only", async () => {
      const fresh = await freshEngine();
      await expect(fresh.connect(env.other).finalizeBootstrap()).to.be.revertedWithCustomError(
        fresh,
        "NotOwner"
      );
    });

    it("lets the wiring setters run immediately before it, and not after", async () => {
      const fresh = await freshEngine();
      await expect(fresh.setWriter(env.other.address, true)).to.emit(fresh, "WriterSet");
      await expect(fresh.finalizeBootstrap()).to.emit(fresh, "Bootstrapped");
      await expect(fresh.setWriter(env.other.address, false)).to.be.revertedWithCustomError(
        fresh,
        "NotQueued"
      );
    });
  });

  /**
   * Each entry is one guarded setter: how to queue it, how to execute it, the id `cancel` takes,
   * and the events the two halves emit. The behaviour is identical across all five, so asserting
   * it five times by hand would mostly be an opportunity to assert it five different ways.
   */
  const guarded = [
    {
      name: "AgentRegistry.setRouter",
      of: (e) => ({
        contract: e.registry,
        queue: (s) => e.registry.connect(s).queueRouter(e.other.address),
        execute: (s) => e.registry.connect(s).setRouter(e.other.address),
        action: () => e.registry.routerAction(e.other.address),
        queuedEvent: "RouterQueued",
        setEvent: "RouterSet",
        landed: async () => expect(await e.registry.router()).to.equal(e.other.address),
      }),
    },
    {
      name: "AgentRegistry.setTreasury",
      of: (e) => ({
        contract: e.registry,
        queue: (s) => e.registry.connect(s).queueTreasury(e.other.address),
        execute: (s) => e.registry.connect(s).setTreasury(e.other.address),
        action: () => e.registry.treasuryAction(e.other.address),
        queuedEvent: "TreasuryQueued",
        setEvent: "TreasurySet",
        landed: async () => expect(await e.registry.treasury()).to.equal(e.other.address),
      }),
    },
    {
      name: "ReputationEngine.setWriter",
      of: (e) => ({
        contract: e.engine,
        queue: (s) => e.engine.connect(s).queueWriter(e.other.address, true),
        execute: (s) => e.engine.connect(s).setWriter(e.other.address, true),
        action: () => e.engine.writerAction(e.other.address, true),
        queuedEvent: "WriterQueued",
        setEvent: "WriterSet",
        landed: async () => expect(await e.engine.writers(e.other.address)).to.equal(true),
      }),
    },
    {
      name: "ExecutionRouter.setAdapter",
      of: (e) => ({
        contract: e.router,
        queue: (s) => e.router.connect(s).queueAdapter(Tier.Bronze, ethers.ZeroAddress),
        execute: (s) => e.router.connect(s).setAdapter(Tier.Bronze, ethers.ZeroAddress),
        action: () => e.router.adapterAction(Tier.Bronze, ethers.ZeroAddress),
        queuedEvent: "AdapterQueued",
        setEvent: "AdapterSet",
        landed: async () =>
          expect(await e.router.adapters(Tier.Bronze)).to.equal(ethers.ZeroAddress),
      }),
    },
    {
      name: "ExecutionRouter.setInputAttestor",
      of: (e) => ({
        contract: e.router,
        queue: (s) => e.router.connect(s).queueInputAttestor(e.other.address),
        execute: (s) => e.router.connect(s).setInputAttestor(e.other.address),
        action: () => e.router.inputAttestorAction(e.other.address),
        queuedEvent: "InputAttestorQueued",
        setEvent: "InputAttestorSet",
        landed: async () => expect(await e.router.inputAttestor()).to.equal(e.other.address),
      }),
    },
  ];

  for (const entry of guarded) {
    describe(entry.name, () => {
      let g;
      let owner;

      beforeEach(() => {
        g = entry.of(env);
        owner = env.owner;
      });

      it("cannot execute without being queued", async () => {
        await expect(g.execute(owner)).to.be.revertedWithCustomError(g.contract, "NotQueued");
      });

      it("announces the queue, with the eta it actually stored", async () => {
        const tx = await g.queue(owner);
        const receipt = await tx.wait();
        const queuedAt = (await ethers.provider.getBlock(receipt.blockNumber)).timestamp;
        const action = await g.action();

        expect(await g.contract.timelockEta(action)).to.equal(queuedAt + DELAY);
        await expect(tx)
          .to.emit(g.contract, "ActionQueued")
          .withArgs(action, queuedAt + DELAY)
          .and.to.emit(g.contract, g.queuedEvent);
      });

      it("cannot execute one second early", async () => {
        await g.queue(owner);
        const eta = await g.contract.timelockEta(await g.action());
        await at(eta - 1n);
        await expect(g.execute(owner)).to.be.revertedWithCustomError(g.contract, "Premature");
      });

      it("executes on the eta itself, and announces that too", async () => {
        await g.queue(owner);
        const eta = await g.contract.timelockEta(await g.action());
        await at(eta);
        await expect(g.execute(owner)).to.emit(g.contract, g.setEvent);
        await g.landed();
      });

      it("still executes on the last second of the grace window", async () => {
        await g.queue(owner);
        const eta = await g.contract.timelockEta(await g.action());
        await at(eta + BigInt(GRACE));
        await expect(g.execute(owner)).to.emit(g.contract, g.setEvent);
        await g.landed();
      });

      /** A plan nobody executed and nobody withdrew must not survive as a standing option. */
      it("goes stale one second later", async () => {
        await g.queue(owner);
        const eta = await g.contract.timelockEta(await g.action());
        await at(eta + BigInt(GRACE) + 1n);
        await expect(g.execute(owner)).to.be.revertedWithCustomError(g.contract, "Stale");
      });

      /**
       * The queue entry is consumed on execution. Without that, one announcement would buy an
       * unlimited number of rewirings — including reinstating a change the owner had visibly
       * reverted, years later, in silence.
       */
      it("cannot be executed twice on one announcement", async () => {
        await g.queue(owner);
        const eta = await g.contract.timelockEta(await g.action());
        await at(eta);
        await g.execute(owner);
        expect(await g.contract.timelockEta(await g.action())).to.equal(0);
        await expect(g.execute(owner)).to.be.revertedWithCustomError(g.contract, "NotQueued");
      });

      it("can be cancelled before it lands", async () => {
        await g.queue(owner);
        const action = await g.action();
        const eta = await g.contract.timelockEta(action);

        await expect(g.contract.cancel(action))
          .to.emit(g.contract, "ActionCancelled")
          .withArgs(action);
        expect(await g.contract.timelockEta(action)).to.equal(0);

        await at(eta);
        await expect(g.execute(owner)).to.be.revertedWithCustomError(g.contract, "NotQueued");
      });

      it("is owner-only to queue, to execute and to cancel", async () => {
        await expect(g.queue(env.other)).to.be.revertedWithCustomError(g.contract, "NotOwner");

        await g.queue(owner);
        const action = await g.action();
        await expect(g.contract.connect(env.other).cancel(action)).to.be.revertedWithCustomError(
          g.contract,
          "NotOwner"
        );

        await at(await g.contract.timelockEta(action));
        await expect(g.execute(env.other)).to.be.revertedWithCustomError(g.contract, "NotOwner");
      });
    });
  }

  describe("action ids", () => {
    /**
     * `cancel` takes a raw id, so an id reconstructed off a slightly different encoding cancels
     * nothing while the call still succeeds. These getters exist so nobody has to reconstruct
     * one, which is only useful if they agree with what `queue` actually wrote.
     */
    it("distinguish their arguments", async () => {
      expect(await env.registry.routerAction(env.other.address)).to.not.equal(
        await env.registry.routerAction(env.consumer.address)
      );
      expect(await env.engine.writerAction(env.other.address, true)).to.not.equal(
        await env.engine.writerAction(env.other.address, false)
      );
      expect(await env.router.adapterAction(Tier.Bronze, ethers.ZeroAddress)).to.not.equal(
        await env.router.adapterAction(Tier.Silver, ethers.ZeroAddress)
      );
    });

    /**
     * Two setters on the same contract must not collide. They do not, because an action id
     * commits to the selector as well as the arguments — which is what stops a queued treasury
     * change from being executable as a router change to the same address.
     */
    it("do not collide across setters on one contract", async () => {
      expect(await env.registry.routerAction(env.other.address)).to.not.equal(
        await env.registry.treasuryAction(env.other.address)
      );

      await env.registry.queueTreasury(env.other.address);
      const eta = await env.registry.timelockEta(
        await env.registry.treasuryAction(env.other.address)
      );
      await at(eta);
      await expect(env.registry.setRouter(env.other.address)).to.be.revertedWithCustomError(
        env.registry,
        "NotQueued"
      );
    });

    /** A queued grant must not be executable as a revocation. */
    it("do not let a queued writer grant execute as a revocation", async () => {
      await env.engine.queueWriter(env.other.address, true);
      const eta = await env.engine.timelockEta(
        await env.engine.writerAction(env.other.address, true)
      );
      await at(eta);
      await expect(env.engine.setWriter(env.other.address, false)).to.be.revertedWithCustomError(
        env.engine,
        "NotQueued"
      );

      await env.engine.setWriter(env.other.address, true);
      expect(await env.engine.writers(env.other.address)).to.equal(true);
    });

    /** The same adapter at two tiers is two different changes. */
    it("do not let an adapter queued for one tier land on another", async () => {
      await env.router.queueAdapter(Tier.Silver, env.teeAdapter.target);
      const eta = await env.router.timelockEta(
        await env.router.adapterAction(Tier.Silver, env.teeAdapter.target)
      );
      await at(eta);
      await expect(
        env.router.setAdapter(Tier.Gold, env.teeAdapter.target)
      ).to.be.revertedWithCustomError(env.router, "NotQueued");
    });
  });

  describe("cancel", () => {
    it("refuses an action that was never queued", async () => {
      await expect(env.registry.cancel(ethers.id("nothing"))).to.be.revertedWithCustomError(
        env.registry,
        "NotQueued"
      );
    });
  });

  describe("queueing again", () => {
    /**
     * Re-queueing restarts the clock rather than keeping the earlier, nearer eta. The alternative
     * would let an owner queue a change, wait out the delay quietly, and then re-announce it as
     * though the notice period were only starting — while it was already executable.
     */
    it("restarts the clock, and the restarted clock governs", async () => {
      await env.registry.queueRouter(env.other.address);
      const action = await env.registry.routerAction(env.other.address);
      const first = await env.registry.timelockEta(action);

      await at(first - BigInt(DAY));
      await env.registry.queueRouter(env.other.address);
      const second = await env.registry.timelockEta(action);
      expect(second).to.be.greaterThan(first);

      await at(first);
      await expect(env.registry.setRouter(env.other.address)).to.be.revertedWithCustomError(
        env.registry,
        "Premature"
      );

      await at(second);
      await expect(env.registry.setRouter(env.other.address)).to.emit(env.registry, "RouterSet");
    });
  });

  describe("the delay itself", () => {
    /**
     * The number is not arbitrary. An agent that objects to a rewiring has exactly one remedy —
     * withdraw its bond — and that takes `UNBONDING_PERIOD`. A notice period shorter than the
     * exit it exists to permit is a notice period that does nothing.
     */
    it("is at least the unbonding period", async () => {
      expect(await env.registry.TIMELOCK_DELAY()).to.be.at.least(
        await env.registry.UNBONDING_PERIOD()
      );
    });

    it("is the same on every contract that has one", async () => {
      const delay = await env.registry.TIMELOCK_DELAY();
      expect(await env.engine.TIMELOCK_DELAY()).to.equal(delay);
      expect(await env.router.TIMELOCK_DELAY()).to.equal(delay);
    });
  });

  describe("what is deliberately not covered", () => {
    /**
     * Recorded rather than assumed. The economic parameters stay immediate: each is bounded in
     * its own setter, they move on a different cadence, and none of them can make a dishonest
     * execution verify. Three weeks in front of a fee change would buy nothing and would teach
     * everyone to route around the mechanism.
     */
    it("leaves the economic parameters immediate", async () => {
      await expect(env.router.setMinFeeBps(25)).to.emit(env.router, "ParametersUpdated");
      expect(await env.router.minFeeBps()).to.equal(25);

      await env.router.setDeliveryWindows(30 * 60, 10 * 60);
      expect(await env.router.minDeliveryWindow()).to.equal(30 * 60);

      await env.registry.setLimits(1n, 2n);
      expect(await env.registry.minBond()).to.equal(1n);
    });

    /** Ownership transfer keeps its own two-step guard and is not queued through this one. */
    it("leaves ownership transfer on its own two-step path", async () => {
      await env.registry.transferOwnership(env.other.address);
      await env.registry.connect(env.other).acceptOwnership();
      expect(await env.registry.owner()).to.equal(env.other.address);
    });

    /** Nothing above should have disturbed the clock for other suites. */
    it("leaves the chain at a sane timestamp", async () => {
      expect(await now()).to.be.greaterThan(0);
    });
  });
});

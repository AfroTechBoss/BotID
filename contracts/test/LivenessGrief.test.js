const { expect } = require("chai");
const { ethers } = require("hardhat");
const { E18, Tier, Status, now, increaseTime, deployProtocol, registerAgent } = require("./helpers");

const MINUTE = 60;
const HOUR = 3600;

/**
 * Regression suite for the liveness-griefing vector.
 *
 * `requestExecution` is permissionless and takes `inputCommitment` on trust. Before the fix, an
 * attacker could therefore commission a request built on a commitment it had invented, which no
 * operator could ever satisfy, on a deadline no operator could ever meet — then call the
 * permissionless `markExpired` itself and collect the challenger bounty out of the agent's bond.
 * The agent could neither deliver nor decline.
 *
 * These tests pin both halves of the defence: a request must allow a deliverable window, and an
 * operator may decline one at order time without taking a fault.
 */
describe("liveness griefing — the request an agent could not refuse", function () {
  let env, agent;

  beforeEach(async function () {
    env = await deployProtocol();
    agent = await registerAgent(env, { tier: Tier.Bronze, bond: E18(1_000_000) });
  });

  /**
   * Commission a request against `agent` with an invented commitment nothing can satisfy.
   *
   * The notional is small but never zero: a request with nothing at risk is invisible to
   * `withdrawEarly`'s liability gate, so `requestExecution` refuses one outright. The fee follows
   * it at the floor. Neither is the defence being tested here — they only mean the griefer now
   * pays something for the attempt.
   */
  async function commissionUnbuildable(caller, opts = {}) {
    const deliverBy = (await now()) + (opts.window ?? HOUR);
    const notional = opts.notional ?? E18(1_000);
    const tx = await env.router
      .connect(caller)
      .requestExecution(
        agent.agentId,
        opts.commitment ?? ethers.id(`garbage-${opts.nonce ?? 0}`),
        notional,
        opts.fee ?? (notional * (await env.router.minFeeBps())) / 10_000n,
        deliverBy,
        ""
      );
    const receipt = await tx.wait();
    return receipt.logs
      .map((l) => {
        try {
          return env.router.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e) => e && e.name === "ExecutionRequested").args.requestId;
  }

  describe("minimum delivery window", function () {
    it("rejects a deadline no operator could meet", async function () {
      // The old floor: strictly in the future, which the very next block satisfies.
      await expect(
        commissionUnbuildable(env.other, { window: 3 })
      ).to.be.revertedWithCustomError(env.router, "DeliveryWindowTooShort");
    });

    it("rejects a deadline one second inside the window", async function () {
      await expect(
        commissionUnbuildable(env.other, { window: 15 * MINUTE - 2 })
      ).to.be.revertedWithCustomError(env.router, "DeliveryWindowTooShort");
    });

    it("accepts a deadline exactly on the window", async function () {
      // +1 because the request mines one second after `now()` is read.
      const requestId = await commissionUnbuildable(env.other, { window: 15 * MINUTE + 1 });
      expect((await env.router.getRequest(requestId)).status).to.equal(Status.Pending);
    });

    it("is owner-settable, and holds rejection strictly inside delivery", async function () {
      await env.router.setDeliveryWindows(5 * MINUTE, 2 * MINUTE);
      expect(await env.router.minDeliveryWindow()).to.equal(5 * MINUTE);
      expect(await env.router.rejectionWindow()).to.equal(2 * MINUTE);

      const requestId = await commissionUnbuildable(env.other, { window: 5 * MINUTE + 1 });
      expect((await env.router.getRequest(requestId)).status).to.equal(Status.Pending);

      for (const bad of [
        [5 * MINUTE, 5 * MINUTE], // equal — leaves no margin
        [5 * MINUTE, 6 * MINUTE], // inverted
        [0, 0], // switches the mechanism off
        [5 * MINUTE, 0], // no way to decline
      ]) {
        await expect(env.router.setDeliveryWindows(...bad)).to.be.revertedWithCustomError(
          env.router,
          "InvalidParameter"
        );
      }
    });

    it("is owner-only", async function () {
      await expect(
        env.router.connect(env.other).setDeliveryWindows(5 * MINUTE, 2 * MINUTE)
      ).to.be.reverted;
    });
  });

  describe("reject — the operator's answer to a request it cannot serve", function () {
    it("closes the request with no fault, no slash and a refunded fee", async function () {
      const before = await env.registry.getProfile(agent.agentId);
      const consumerBefore = await env.token.balanceOf(env.other.address);

      const requestId = await commissionUnbuildable(env.other, {
        notional: E18(100_000),
        fee: E18(100),
      });
      expect((await env.registry.getProfile(agent.agentId)).openNotional).to.equal(E18(100_000));

      await expect(env.router.connect(agent.operator).reject(requestId))
        .to.emit(env.router, "ExecutionRejected")
        .withArgs(requestId, agent.agentId, env.other.address);

      const after = await env.registry.getProfile(agent.agentId);
      expect((await env.router.getRequest(requestId)).status).to.equal(Status.Rejected);
      expect(after.faults).to.equal(before.faults);
      expect(after.score).to.equal(before.score);
      expect(after.bond).to.equal(before.bond);
      // Exposure released, so the request cannot be used to squat on the agent's credit line.
      expect(after.openNotional).to.equal(0);
      // The requester is made whole — declining is not a fine.
      expect(await env.token.balanceOf(env.other.address)).to.equal(consumerBefore);
    });

    it("denies the griefer its payday — the whole chain, end to end", async function () {
      const attackerBefore = await env.token.balanceOf(env.other.address);
      const before = await env.registry.getProfile(agent.agentId);

      const requestId = await commissionUnbuildable(env.other, { nonce: 1 });
      await env.router.connect(agent.operator).reject(requestId);

      // The attacker's follow-up is now a no-op: there is nothing left to expire.
      await increaseTime(2 * HOUR);
      await expect(
        env.router.connect(env.other).markExpired(requestId)
      ).to.be.revertedWithCustomError(env.router, "BadStatus");

      const after = await env.registry.getProfile(agent.agentId);
      expect(after.bond).to.equal(before.bond);
      expect(after.faults).to.equal(0);
      expect(after.score).to.equal(before.score);
      expect(after.maxOpenNotional).to.equal(before.maxOpenNotional);
      expect(await env.token.balanceOf(env.other.address)).to.equal(attackerBefore);
    });

    it("survives repetition — 20 rounds leave the agent exactly as it started", async function () {
      const before = await env.registry.getProfile(agent.agentId);
      const attackerBefore = await env.token.balanceOf(env.other.address);

      for (let i = 0; i < 20; i++) {
        const requestId = await commissionUnbuildable(env.other, { nonce: i });
        await env.router.connect(agent.operator).reject(requestId);
      }

      const after = await env.registry.getProfile(agent.agentId);
      expect(after.bond).to.equal(before.bond);
      expect(after.score).to.equal(before.score);
      expect(after.faults).to.equal(0);
      expect(after.openNotional).to.equal(0);
      // The attacker is not up. Gas is now the only thing the attack buys.
      expect(await env.token.balanceOf(env.other.address)).to.equal(attackerBefore);
    });

    it("is operator-only — not the owner, not the consumer, not a stranger", async function () {
      const requestId = await commissionUnbuildable(env.other, { nonce: 2 });
      for (const who of [env.agentOwner, env.other, env.consumer]) {
        await expect(
          env.router.connect(who).reject(requestId)
        ).to.be.revertedWithCustomError(env.router, "NotOperator");
      }
    });

    it("expires with the rejection window, so it cannot be played as a late escape", async function () {
      const requestId = await commissionUnbuildable(env.other, { nonce: 3 });
      await increaseTime(6 * MINUTE);
      await expect(
        env.router.connect(agent.operator).reject(requestId)
      ).to.be.revertedWithCustomError(env.router, "DeadlinePassed");
    });

    it("cannot rescue a request whose deadline already passed", async function () {
      const requestId = await commissionUnbuildable(env.other, { nonce: 4 });
      await increaseTime(2 * HOUR);

      // Even if governance widens the rejection window past this request's deadline, the
      // request itself is beyond saving — the operator had its chance and let it run out.
      await env.router.setDeliveryWindows(10 * HOUR, 9 * HOUR);
      await expect(
        env.router.connect(agent.operator).reject(requestId)
      ).to.be.revertedWithCustomError(env.router, "DeadlinePassed");
    });

    it("cannot be applied twice, or to a request already delivered", async function () {
      const requestId = await commissionUnbuildable(env.other, { nonce: 5 });
      await env.router.connect(agent.operator).reject(requestId);
      await expect(
        env.router.connect(agent.operator).reject(requestId)
      ).to.be.revertedWithCustomError(env.router, "BadStatus");
    });

    it("does not disturb the liveness fault for a request the agent simply ignored", async function () {
      // The point of the fix is to make acceptance real, not to abolish the fault. An operator
      // that lets the rejection window lapse has accepted, and is still on the hook.
      const requestId = await commissionUnbuildable(env.other, {
        nonce: 6,
        notional: E18(100_000),
        fee: E18(100),
      });
      await increaseTime(2 * HOUR);
      await env.router.connect(env.other).markExpired(requestId);

      const after = await env.registry.getProfile(agent.agentId);
      expect((await env.router.getRequest(requestId)).status).to.equal(Status.Expired);
      expect(after.faults).to.equal(1);
      expect(after.bond).to.equal(E18(980_000));
    });
  });
});

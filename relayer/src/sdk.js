// The programmatic API. `src/index.js` is the same capabilities behind a command line.
//
// Everything here is a thin wrapper over the loops in agent.js and the reads in AgentRegistry.
// Deliberately thin: the CLI and the SDK run the same code down to the same line numbers, so a
// bug found by one is fixed for both. A second implementation dressed as a convenience layer is
// how two things that are supposed to agree start disagreeing quietly.

const { ethers } = require("ethers");
const config = require("./config");
const { connect } = require("./chain");
const agent = require("./agent");

/** Mirrors the contract's Tier enum. None is 0 and registering with it reverts. */
const Tier = { None: 0, Bronze: 1, Silver: 2, Gold: 3 };

/** Mirrors Types.sol Status, in full — see the comment in contracts/scripts/execute-once.js. */
const Status = {
  None: 0,
  Pending: 1,
  Delivered: 2,
  Challenged: 3,
  Finalized: 4,
  Settled: 5,
  Expired: 6,
  Faulted: 7,
  Rejected: 8,
};

/**
 * An agent that answers work addressed to it.
 *
 *   const agent = new BotIDAgent({
 *     rpcUrl: "https://rpc.bohr.life",
 *     operatorKey: process.env.OPERATOR_KEY,
 *     contracts: { AgentRegistry: "0x…", ExecutionRouter: "0x…", … },
 *   });
 *   const { agentId } = await agent.start();
 *
 * `contracts` is the `contracts` object out of a deploy manifest. Passing it is what frees the
 * package from the repo: with addresses in hand it never looks for a deployments directory that
 * an npm install does not have.
 *
 * One agent per process. The configuration underneath is process-wide, so constructing a second
 * one with different settings throws rather than quietly reconfiguring the first — see the note
 * on `config.apply`.
 */
class BotIDAgent {
  constructor(options = {}) {
    this.options = options;
    this.handle = null;
  }

  /** Attach to the chain and begin answering requests. Resolves once it is watching. */
  async start() {
    if (this.handle) throw new Error("agent is already started");
    this.handle = await agent.start(this.options);
    return { agentId: this.handle.agentId, operator: this.handle.operator, tier: this.handle.tier };
  }

  /** Detach. Work already accepted is left to finish — dropping it is a liveness fault. */
  async stop() {
    if (!this.handle) return;
    await this.handle.stop();
    this.handle = null;
  }

  /** Resolves only when the agent stops. `await agent.wait()` is a service's main loop. */
  wait() {
    if (!this.handle) throw new Error("agent is not started");
    return this.handle.stopped;
  }
}

/**
 * Read-only reputation, for the side that is doing the hiring.
 *
 * No key, no transactions, nothing to fund — it is a consumer asking the chain a question about
 * somebody else. `check` is the one that matters: it is the same question `meetsPolicy` answers
 * on chain, so a bot that screens with it and a vault that enforces it in Solidity cannot
 * disagree about who was eligible.
 */
class BotIDReader {
  constructor(options = {}) {
    this.options = options;
    this.conn = null;
  }

  async _connect() {
    if (!this.conn) {
      config.apply(this.options);
      this.conn = await connect({});
    }
    return this.conn;
  }

  /** Everything on the record for one agent, or null if the id was never issued. */
  async agent(agentId) {
    const { contracts } = await this._connect();
    const id = BigInt(agentId);
    const [a, profile] = await Promise.all([
      contracts.registry.getAgent(id),
      contracts.registry.getProfile(id),
    ]);
    // An unissued id does not revert — Solidity hands back a zero-filled struct, and a mapping
    // has no opinion about which of its keys are real. Registration always sets an owner, so a
    // zero owner is what separates "absent" from "empty".
    if (a.owner === ethers.ZeroAddress) return null;
    return {
      agentId: id,
      owner: a.owner,
      operator: a.operator,
      tier: Number(a.tier),
      active: a.active,
      modelCommitment: a.modelCommitment,
      bond: a.bond,
      openNotional: a.openNotional,
      maxOpenNotional: profile.maxOpenNotional,
      score: Number(profile.score),
      faults: Number(profile.faults),
      settledExecutions: Number(profile.settledExecutions),
      lastActiveAt: Number(profile.lastActiveAt),
    };
  }

  /**
   * The chain's own verdict on whether an agent clears a hiring policy.
   *
   * Unset fields are the permissive value rather than zero-as-accident: an omitted `minTier` is
   * any tier, an omitted `maxStalenessSeconds` is no staleness check at all (which is what the
   * contract means by 0). The one exception is `maxFaults`, where the permissive default would
   * be infinity and the useful default is zero — someone who did not think about faults almost
   * certainly does not want an agent that has committed one.
   */
  async check(agentId, policy = {}) {
    const { contracts } = await this._connect();
    return contracts.registry.meetsPolicy(BigInt(agentId), {
      minScore: policy.minScore ?? 0,
      minTier: policy.minTier ?? Tier.None,
      maxFaults: policy.maxFaults ?? 0,
      minBond: policy.minBond ?? 0n,
      maxStalenessSeconds: policy.maxStalenessSeconds ?? 0,
    });
  }

  /** One execution's current state, for following work already commissioned. */
  async request(requestId) {
    const { contracts } = await this._connect();
    return contracts.router.getRequest(requestId);
  }
}

module.exports = { BotIDAgent, BotIDReader, Tier, Status };

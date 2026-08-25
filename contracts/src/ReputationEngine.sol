// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Outcome} from "./libraries/Types.sol";
import {ScoreMath} from "./libraries/ScoreMath.sol";
import {Ownable, Timelocked} from "./libraries/Utils.sol";
import {FaultKind, IReputationEngine} from "./interfaces/IReputationEngine.sol";

/// @title ReputationEngine
/// @notice Capital-weighted, time-decayed reputation driven by *settled economic outcomes*.
/// @dev This is the deliberate departure from the v0 design, which scored agents on whether
///      their proofs verified. Invalid proofs revert and are simply never submitted, so that
///      signal is constant across all agents. What actually distinguishes agents is whether
///      they deliver, whether they stay inside their declared limits, and what happens to the
///      capital they were trusted with.
contract ReputationEngine is IReputationEngine, Timelocked {
    using ScoreMath for uint32;

    struct Record {
        uint32 score;
        uint32 faults;
        uint32 settledExecutions;
        uint64 lastUpdateAt;
        uint64 lastActiveAt;
        bool initialized;
    }

    /// @notice Notional at which one observation moves the score halfway toward its quality.
    /// @dev The anti-grinding parameter. Dust executions barely move the score; a large
    ///      execution moves it a lot. Raising this makes reputation slower and more expensive
    ///      to manufacture.
    uint256 public halfWeight = 100_000e18;

    /// @notice Capital weight is capped so a single outsized execution cannot dominate.
    uint256 public weightCap = 1_000_000e18;

    /// @notice Total weight one *counterparty* may spend on one agent's score per `decayHalfLife`.
    /// @dev `weightCap` bounds how much a single execution counts; this bounds how much a single
    ///      consumer counts, which is a different attack. `settle` lets the consumer report the
    ///      economic result unilaterally, and the damage of a false report scales with `notional`
    ///      — which the consumer also chooses — while the cost is only `minFeeBps` of it. Raising
    ///      the fee floor cannot close that gap, because the attacker scales both sides of it.
    ///      What actually closes it is denying any one counterparty the ability to define an
    ///      agent's reputation: an outcome only carries the weight still left in that consumer's
    ///      budget, and reaching a high score, or destroying one, takes several independent
    ///      counterparties rather than one determined one.
    ///
    ///      At the default of half `halfWeight`, one consumer moves a score at most a third of the
    ///      way toward its claimed quality — enough to register serious displeasure, not enough to
    ///      destroy. The budget is not consumed permanently: it refills toward zero on the same
    ///      half-life as the score itself, so a long-standing honest counterparty keeps its voice.
    ///      Spending is symmetric, because this is an influence budget and not a punishment.
    ///      Zero disables the cap.
    uint256 public consumerWeightCap = 50_000e18;

    /// @notice Time for an idle agent's score to move halfway back to neutral.
    uint256 public decayHalfLife = 90 days;

    uint32 public livenessHaircutBps = 1_500;
    uint32 public verificationHaircutBps = 6_000;

    /// @dev Weight already spent by one consumer against one agent, as of `lastAt`. Read through
    ///      `ScoreMath.fade` rather than directly — the stored figure is always stale by design.
    struct Budget {
        uint128 used;
        uint64 lastAt;
    }

    mapping(uint256 => Record) private _records;
    mapping(uint256 => mapping(address => Budget)) private _budgets;
    mapping(address => bool) public writers;

    error NotWriter();
    error AlreadyInitialized();
    error NotInitialized();
    error InvalidParameter();

    event WriterSet(address indexed writer, bool allowed);
    event WriterQueued(address indexed writer, bool allowed, uint64 eta);
    event AgentInitialized(uint256 indexed agentId, uint32 score);
    /// @param weight The weight actually applied — already capped by both `weightCap` and the
    ///        consumer's remaining budget, so a watcher can see when a report was discounted.
    event OutcomeRecorded(
        uint256 indexed agentId,
        address indexed consumer,
        uint32 quality,
        uint256 weight,
        uint32 newScore
    );
    event FaultRecorded(uint256 indexed agentId, FaultKind kind, uint32 newScore, uint32 faults);
    event ParametersUpdated();

    constructor(address initialOwner) Ownable(initialOwner) {}

    modifier onlyWriter() {
        if (!writers[msg.sender]) revert NotWriter();
        _;
    }

    // ---------------------------------------------------------------- admin

    /// @dev A writer can move any agent's score without limit, and a score is what a consumer
    ///      policy filters on — so granting one is granting the power to make a bad agent pass
    ///      every eligibility check in the protocol. That waits.
    ///
    ///      Revocation waits too, which is the uncomfortable half of this design and is deliberate:
    ///      an asymmetric timelock that let the owner remove a writer instantly would let the owner
    ///      silently stop the router from recording faults, which is the same power in the other
    ///      direction. Removing a compromised writer is handled by removing the owner's reason to
    ///      trust it — pausing at the router — not by a fast path here.
    function queueWriter(address writer, bool allowed) external {
        emit WriterQueued(writer, allowed, _queue(_writerAction(writer, allowed)));
    }

    function setWriter(address writer, bool allowed) external onlyOwner {
        _consume(_writerAction(writer, allowed));
        writers[writer] = allowed;
        emit WriterSet(writer, allowed);
    }

    /// @notice The action id `queueWriter(writer, allowed)` produces, and `cancel` expects.
    /// @dev `allowed` is part of the id, so a queued grant cannot be executed as a revocation or
    ///      the other way round.
    function writerAction(address writer, bool allowed) external pure returns (bytes32) {
        return _writerAction(writer, allowed);
    }

    function _writerAction(address writer, bool allowed) private pure returns (bytes32) {
        return keccak256(abi.encode(this.setWriter.selector, writer, allowed));
    }

    function setParameters(
        uint256 halfWeight_,
        uint256 weightCap_,
        uint256 consumerWeightCap_,
        uint256 decayHalfLife_,
        uint32 livenessHaircutBps_,
        uint32 verificationHaircutBps_
    ) external onlyOwner {
        if (halfWeight_ == 0 || weightCap_ == 0 || decayHalfLife_ == 0) revert InvalidParameter();
        if (livenessHaircutBps_ > 10_000 || verificationHaircutBps_ > 10_000) {
            revert InvalidParameter();
        }
        // Budgets are stored in 128 bits and are never allowed above the cap, so the cap is what
        // has to fit. Zero is legal and means "no per-consumer limit".
        if (consumerWeightCap_ > type(uint128).max) revert InvalidParameter();
        halfWeight = halfWeight_;
        weightCap = weightCap_;
        consumerWeightCap = consumerWeightCap_;
        decayHalfLife = decayHalfLife_;
        livenessHaircutBps = livenessHaircutBps_;
        verificationHaircutBps = verificationHaircutBps_;
        emit ParametersUpdated();
    }

    // ---------------------------------------------------------------- writes

    function initAgent(uint256 agentId) external onlyWriter {
        Record storage r = _records[agentId];
        if (r.initialized) revert AlreadyInitialized();
        r.initialized = true;
        r.score = ScoreMath.NEUTRAL;
        r.lastUpdateAt = uint64(block.timestamp);
        r.lastActiveAt = uint64(block.timestamp);
        emit AgentInitialized(agentId, ScoreMath.NEUTRAL);
    }

    function recordOutcome(
        uint256 agentId,
        address consumer,
        Outcome calldata outcome,
        uint256 notional,
        uint32 lossToleranceBps
    ) external onlyWriter {
        Record storage r = _records[agentId];
        if (!r.initialized) revert NotInitialized();

        uint32 decayed = _decayed(r);
        uint32 q = ScoreMath.quality(outcome, lossToleranceBps);

        uint256 weight = notional > weightCap ? weightCap : notional;
        weight = _spend(agentId, consumer, weight);
        uint32 newScore = decayed.observe(q, weight, halfWeight);

        r.score = newScore;
        r.lastUpdateAt = uint64(block.timestamp);
        r.lastActiveAt = uint64(block.timestamp);
        unchecked {
            r.settledExecutions += 1;
        }

        emit OutcomeRecorded(agentId, consumer, q, weight, newScore);
    }

    /// @notice Draw `weight` from `consumer`'s budget against `agentId`, returning what it got.
    /// @dev Returns zero once the budget is exhausted, and `observe` leaves the score untouched at
    ///      zero weight — an exhausted counterparty's reports still settle, still pay the agent,
    ///      and still count toward `settledExecutions`; they simply stop moving the score. That is
    ///      the intended shape: the protocol is refusing to take one party's word for it again,
    ///      not refusing to do business.
    function _spend(uint256 agentId, address consumer, uint256 weight) private returns (uint256) {
        uint256 cap = consumerWeightCap;
        if (cap == 0) return weight;

        Budget storage b = _budgets[agentId][consumer];
        uint256 used =
            b.lastAt == 0 ? 0 : ScoreMath.fade(b.used, block.timestamp - b.lastAt, decayHalfLife);

        uint256 remaining = cap > used ? cap - used : 0;
        if (weight > remaining) weight = remaining;

        // Bounded by `cap`, which `setParameters` holds inside uint128.
        b.used = uint128(used + weight);
        b.lastAt = uint64(block.timestamp);
        return weight;
    }

    function recordFault(uint256 agentId, FaultKind kind) external onlyWriter {
        Record storage r = _records[agentId];
        if (!r.initialized) revert NotInitialized();

        uint32 haircutBps =
            kind == FaultKind.Liveness ? livenessHaircutBps : verificationHaircutBps;

        // Haircut is applied after decay but is *not* an EWMA observation: a fault must not be
        // diluted by execution volume. Volume is exactly what a griefing agent can manufacture.
        uint32 newScore = ScoreMath.haircut(_decayed(r), haircutBps);

        r.score = newScore;
        r.lastUpdateAt = uint64(block.timestamp);
        // `lastActiveAt` is deliberately NOT stamped here. It answers "when did this agent last
        // do its job", which is what `meetsPolicy`'s staleness check screens on, and a fault is
        // the opposite of doing the job. Stamping it made the liveness case self-defeating: an
        // agent that had gone dark accrued a Liveness fault via `markExpired`, and the fault
        // itself refreshed its freshness — so any passer-by could restore a stale agent to
        // `meetsPolicy` eligibility, for gas, by reporting that it had failed. Only
        // `recordOutcome` and `initialize` stamp it, because only those mean work happened.
        unchecked {
            r.faults += 1;
        }

        emit FaultRecorded(agentId, kind, newScore, r.faults);
    }

    // ---------------------------------------------------------------- reads

    function getScore(uint256 agentId) public view returns (uint32) {
        Record storage r = _records[agentId];
        if (!r.initialized) return 0;
        return _decayed(r);
    }

    function getStats(uint256 agentId)
        external
        view
        returns (uint32 score, uint32 faults, uint32 settledExecutions, uint64 lastActiveAt)
    {
        Record storage r = _records[agentId];
        return (getScore(agentId), r.faults, r.settledExecutions, r.lastActiveAt);
    }

    /// @notice Weight `consumer` may still spend on `agentId`'s score right now.
    /// @dev A consumer can quote this before settling to see whether its report will carry.
    function remainingWeight(uint256 agentId, address consumer) external view returns (uint256) {
        uint256 cap = consumerWeightCap;
        if (cap == 0) return type(uint256).max;

        Budget storage b = _budgets[agentId][consumer];
        uint256 used =
            b.lastAt == 0 ? 0 : ScoreMath.fade(b.used, block.timestamp - b.lastAt, decayHalfLife);
        return cap > used ? cap - used : 0;
    }

    function _decayed(Record storage r) private view returns (uint32) {
        return ScoreMath.decay(r.score, block.timestamp - r.lastUpdateAt, decayHalfLife);
    }
}

// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Outcome} from "./libraries/Types.sol";
import {ScoreMath} from "./libraries/ScoreMath.sol";
import {Ownable} from "./libraries/Utils.sol";
import {FaultKind, IReputationEngine} from "./interfaces/IReputationEngine.sol";

/// @title ReputationEngine
/// @notice Capital-weighted, time-decayed reputation driven by *settled economic outcomes*.
/// @dev This is the deliberate departure from the v0 design, which scored agents on whether
///      their proofs verified. Invalid proofs revert and are simply never submitted, so that
///      signal is constant across all agents. What actually distinguishes agents is whether
///      they deliver, whether they stay inside their declared limits, and what happens to the
///      capital they were trusted with.
contract ReputationEngine is IReputationEngine, Ownable {
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

    /// @notice Time for an idle agent's score to move halfway back to neutral.
    uint256 public decayHalfLife = 90 days;

    uint32 public livenessHaircutBps = 1_500;
    uint32 public verificationHaircutBps = 6_000;

    mapping(uint256 => Record) private _records;
    mapping(address => bool) public writers;

    error NotWriter();
    error AlreadyInitialized();
    error NotInitialized();
    error InvalidParameter();

    event WriterSet(address indexed writer, bool allowed);
    event AgentInitialized(uint256 indexed agentId, uint32 score);
    event OutcomeRecorded(
        uint256 indexed agentId, uint32 quality, uint256 weight, uint32 newScore
    );
    event FaultRecorded(uint256 indexed agentId, FaultKind kind, uint32 newScore, uint32 faults);
    event ParametersUpdated();

    constructor(address initialOwner) Ownable(initialOwner) {}

    modifier onlyWriter() {
        if (!writers[msg.sender]) revert NotWriter();
        _;
    }

    // ---------------------------------------------------------------- admin

    function setWriter(address writer, bool allowed) external onlyOwner {
        writers[writer] = allowed;
        emit WriterSet(writer, allowed);
    }

    function setParameters(
        uint256 halfWeight_,
        uint256 weightCap_,
        uint256 decayHalfLife_,
        uint32 livenessHaircutBps_,
        uint32 verificationHaircutBps_
    ) external onlyOwner {
        if (halfWeight_ == 0 || weightCap_ == 0 || decayHalfLife_ == 0) revert InvalidParameter();
        if (livenessHaircutBps_ > 10_000 || verificationHaircutBps_ > 10_000) {
            revert InvalidParameter();
        }
        halfWeight = halfWeight_;
        weightCap = weightCap_;
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
        Outcome calldata outcome,
        uint256 notional,
        uint32 lossToleranceBps
    ) external onlyWriter {
        Record storage r = _records[agentId];
        if (!r.initialized) revert NotInitialized();

        uint32 decayed = _decayed(r);
        uint32 q = ScoreMath.quality(outcome, lossToleranceBps);

        uint256 weight = notional > weightCap ? weightCap : notional;
        uint32 newScore = decayed.observe(q, weight, halfWeight);

        r.score = newScore;
        r.lastUpdateAt = uint64(block.timestamp);
        r.lastActiveAt = uint64(block.timestamp);
        unchecked {
            r.settledExecutions += 1;
        }

        emit OutcomeRecorded(agentId, q, weight, newScore);
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
        r.lastActiveAt = uint64(block.timestamp);
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

    function _decayed(Record storage r) private view returns (uint32) {
        return ScoreMath.decay(r.score, block.timestamp - r.lastUpdateAt, decayHalfLife);
    }
}

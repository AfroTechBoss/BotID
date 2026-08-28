// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Outcome} from "../libraries/Types.sol";

enum FaultKind {
    Liveness, //     accepted a request and never delivered
    Verification //  lost a challenge — could not back its attestation with a proof
}

/// @title IReputationEngine
/// @notice Write side of reputation. Only the registry (init) and router (updates) may call.
interface IReputationEngine {
    function initAgent(uint256 agentId) external;

    /// @notice Fold a settled execution into the agent's score, weighted by capital at risk.
    /// @param consumer Who reported this outcome. The weight is drawn from that counterparty's
    ///        budget, so no single one can define an agent's score — see `consumerWeightCap`.
    /// @param notional How much to weight the observation by, which is the request's notional
    ///        on every path where a counterparty actually reported. Callers must pass zero when
    ///        `outcome` is a placeholder rather than a report — see `ExecutionRouter
    ///        .settleDefault`. At zero the execution still counts and still pays; it just does
    ///        not move the score, because nobody said anything about how it went.
    function recordOutcome(
        uint256 agentId,
        address consumer,
        Outcome calldata outcome,
        uint256 notional,
        uint32 lossToleranceBps
    ) external;

    /// @notice Weight `consumer` may still spend on `agentId`'s score.
    function remainingWeight(uint256 agentId, address consumer) external view returns (uint256);

    /// @notice Record a fault. Faults apply a direct haircut and are counted separately, so a
    ///         high volume of routine successes cannot smooth them away.
    function recordFault(uint256 agentId, FaultKind kind) external;

    function getScore(uint256 agentId) external view returns (uint32);

    function getStats(uint256 agentId)
        external
        view
        returns (uint32 score, uint32 faults, uint32 settledExecutions, uint64 lastActiveAt);
}

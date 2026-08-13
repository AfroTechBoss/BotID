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
    function recordOutcome(
        uint256 agentId,
        Outcome calldata outcome,
        uint256 notional,
        uint32 lossToleranceBps
    ) external;

    /// @notice Record a fault. Faults apply a direct haircut and are counted separately, so a
    ///         high volume of routine successes cannot smooth them away.
    function recordFault(uint256 agentId, FaultKind kind) external;

    function getScore(uint256 agentId) external view returns (uint32);

    function getStats(uint256 agentId)
        external
        view
        returns (uint32 score, uint32 faults, uint32 settledExecutions, uint64 lastActiveAt);
}

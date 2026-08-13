// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Policy, Profile} from "../libraries/Types.sol";

/// @title IReputationOracle
/// @notice The only interface consumer protocols need. Everything else is protocol internals.
interface IReputationOracle {
    /// @notice Full public profile of an agent, with score already decayed to `block.timestamp`.
    function getProfile(uint256 agentId) external view returns (Profile memory);

    /// @notice Decayed score in the 0..10000 range.
    function getScore(uint256 agentId) external view returns (uint32);

    /// @notice Evaluate an agent against a caller-defined policy.
    /// @dev Consumers set their own thresholds. A conservative vault requires Gold tier and
    ///      zero faults; a prediction market might accept Bronze with a low notional ceiling.
    function meetsPolicy(uint256 agentId, Policy calldata policy) external view returns (bool);

    /// @notice Remaining notional this agent may take on right now.
    function availableCredit(uint256 agentId) external view returns (uint256);
}

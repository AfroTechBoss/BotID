// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Tier, VerificationContext} from "../libraries/Types.sol";

/// @title IVerificationAdapter
/// @notice One adapter per verification tier. The router treats them uniformly.
/// @dev Implementations MUST bind every field of `ctx` into the artifact they check.
///      An adapter that ignores `requestId` reintroduces replay; one that ignores
///      `modelCommitment` lets an agent silently swap models. Both are consensus bugs,
///      not style issues.
interface IVerificationAdapter {
    /// @return The tier this adapter attests to.
    function tier() external view returns (Tier);

    /// @notice Verify an execution attestation.
    /// @param ctx Canonical binding for this execution.
    /// @param attestation Tier-specific payload (signature, TEE quote, or ZK proof).
    /// @return ok True if the attestation is valid for exactly this context.
    function verify(VerificationContext calldata ctx, bytes calldata attestation)
        external
        view
        returns (bool ok);
}

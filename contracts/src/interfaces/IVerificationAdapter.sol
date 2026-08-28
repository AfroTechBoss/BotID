// SPDX-License-Identifier: BUSL-1.1
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

    /// @notice Whether this adapter could accept *any* attestation for `modelCommitment`.
    /// @dev Capability, not validity: a true answer says a correct attestation would be checked
    ///      against something, not that any particular one passes. `verify` remains the only
    ///      thing that decides an actual delivery.
    ///
    ///      This exists because the router needs to ask "can this agent be held to a proof"
    ///      *before* it accepts a challenge. A challenge whose only possible outcome is the
    ///      agent failing to escalate is not a check on the agent, it is a paid attack on it —
    ///      see `ExecutionRouter.challenge`. Implementations must answer for the adapter's own
    ///      configuration only, and must not revert.
    /// @param modelCommitment The agent's registered model commitment.
    /// @return True if an attestation naming this model could be verified today.
    function canVerify(bytes32 modelCommitment) external view returns (bool);
}

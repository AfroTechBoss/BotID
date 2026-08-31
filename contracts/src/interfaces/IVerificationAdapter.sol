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

    /// @notice Verify an attestation *and* record who is credited with producing the work.
    /// @dev The distinction `verify` cannot make. A verifier returning true says the statement is
    ///      true; it does not say who established it. For a signature or an enclave quote those
    ///      are the same question, because the artifact is signed over `ctx` and is worthless to
    ///      anyone else. For a ZK proof they come apart: a proof is a transferable object, valid
    ///      for whoever holds it, and the instance vector names the model and the numbers but not
    ///      the prover. Copy a published proof, register a clone of its model, and the copy
    ///      verifies exactly as well as the original.
    ///
    ///      So the adapter that issues transferable artifacts is the one that has to remember
    ///      which agent presented each one first. This returns that agent. The router does not
    ///      reject a duplicate — the delivered output is still correct, and rejecting would hand
    ///      anyone who front-runs a delivery the power to brick it — it declines to *score* one.
    ///
    ///      Called by the router, on the two paths where it has already bound `ctx` to a
    ///      registered agent and an open request: `deliver`, and `resolveChallenge`. An
    ///      implementation that records anything MUST enforce that — nothing in `ctx` is
    ///      self-authenticating, `agentId` least of all, so an attribution write open to any
    ///      caller is an attribution write open to a hand-built `ctx`. See `ZkAdapter.onlyRouter`
    ///      for what that cost, and `AgentRegistry.setRouter` for the wiring it needs.
    ///
    ///      A duplicate must never revert on either path. Answering a challenge is how an agent
    ///      avoids a slash, so it must not be possible for a different agent, on a different
    ///      request, to make that answer fail.
    /// @return ok Same as `verify`.
    /// @return originator The agent credited with this work: `ctx.agentId` when this attestation
    ///         is new, otherwise whichever agent presented it first. Meaningless when `ok`
    ///         is false.
    function verifyAndAttribute(VerificationContext calldata ctx, bytes calldata attestation)
        external
        returns (bool ok, uint256 originator);
}

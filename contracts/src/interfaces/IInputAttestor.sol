// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IInputAttestor
/// @notice Proves that the inputs an agent claims to have run on came from attested sources.
/// @dev This is the fix for the central hole in the v0 design. A ZK proof of inference shows
///      the model ran on *some* inputs; without this check those inputs can be fabricated by
///      the agent itself, and the proof is a proof of nothing useful.
interface IInputAttestor {
    struct FeedAttestation {
        bytes32 feedId;
        bytes32 valueHash;
        uint64 timestamp;
        bytes[] signatures;
    }

    /// @param inputCommitment Commitment the consumer put in the request.
    /// @param bundle ABI-encoded feed attestations with publisher signatures.
    /// @param asOf Timestamp the inputs must be fresh relative to — the moment the consumer
    ///        created the request and fixed `inputCommitment`.
    /// @return ok True if the bundle hashes to `inputCommitment`, every feed carries a
    ///         publisher quorum, and no feed is staler than the configured max age.
    function verifyInputs(bytes32 inputCommitment, bytes calldata bundle, uint64 asOf)
        external
        view
        returns (bool ok);

    /// @notice Canonical commitment over an ordered bundle of feed readings.
    /// @dev Exposed on the interface so the Gold adapter can re-derive a commitment from
    ///      revealed feed values without duplicating the hashing convention. Signatures are
    ///      not part of the commitment, so a caller that only wants the hash may pass empty
    ///      signature arrays.
    function commit(FeedAttestation[] memory feeds) external view returns (bytes32);
}

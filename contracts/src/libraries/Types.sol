// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Verification strength of an execution. Ordered — higher is stronger.
enum Tier {
    None,
    Bronze, // operator EIP-712 signature, bond-backed, challengeable
    Silver, // TEE attestation, challengeable
    Gold //    ZK proof, immediately final
}

enum Status {
    None,
    Pending, //   requested, awaiting delivery
    Delivered, // delivered, inside challenge window
    Challenged, //challenged, awaiting escalation proof
    Finalized, // verification is settled; awaiting economic settlement
    Settled, //   terminal, outcome recorded
    Expired, //   terminal, never delivered — liveness fault
    Faulted //    terminal, lost a challenge — verification fault
}

/// @notice Canonical binding passed to every verification adapter.
/// @dev Every field here MUST be bound by the adapter into whatever it checks —
///      public signals for ZK, the signed digest for TEE/signature. This is what
///      prevents replay, cross-request substitution, and stale-input attacks.
struct VerificationContext {
    bytes32 requestId;
    uint256 agentId;
    bytes32 modelCommitment;
    bytes32 inputCommitment;
    bytes32 outputCommitment;
    uint64 deliverBy;
    address operator;
}

/// @notice Economic result of an execution, reported by the consumer at settlement.
struct Outcome {
    int256 realizedPnlBps; // signed, relative to notional
    bool slaBreached; //      delivered late or out of spec
    bool limitBreached; //    exceeded the agent's declared risk limits
}

struct Request {
    address consumer;
    uint256 agentId;
    bytes32 inputCommitment;
    bytes32 outputCommitment;
    uint128 notional;
    uint128 fee;
    uint64 createdAt;
    uint64 deliverBy;
    uint64 finalizeAt;
    uint64 settleBy;
    Tier tier;
    Status status;
    address challenger;
    uint128 challengeBond;
    uint64 escalationDeadline;
}

/// @notice Consumer-supplied eligibility policy. The protocol does not dictate thresholds.
struct Policy {
    uint32 minScore;
    Tier minTier;
    uint32 maxFaults;
    uint256 minBond;
    uint64 maxStalenessSeconds;
}

struct Profile {
    address owner;
    Tier tier;
    uint32 score;
    uint32 faults;
    uint32 settledExecutions;
    uint64 lastActiveAt;
    uint256 bond;
    uint256 openNotional;
    uint256 maxOpenNotional;
    bool active;
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VerificationContext} from "./Types.sol";

/// @notice Canonical, domain-separated digest of an execution context.
/// @dev Every adapter binds *this* digest, so no attestation is valid for any other request,
///      agent, model, input set, or output. Dropping a field here reintroduces one of the
///      attacks the redesign closes, so the struct is hashed whole.
library Digest {
    bytes32 internal constant EXECUTION_TYPEHASH = keccak256(
        "Execution(bytes32 requestId,uint256 agentId,bytes32 modelCommitment,bytes32 inputCommitment,bytes32 outputCommitment,uint64 deliverBy)"
    );

    function execution(VerificationContext memory ctx, address verifier)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                EXECUTION_TYPEHASH,
                block.chainid,
                verifier,
                ctx.requestId,
                ctx.agentId,
                ctx.modelCommitment,
                ctx.inputCommitment,
                ctx.outputCommitment,
                ctx.deliverBy
            )
        );
    }
}

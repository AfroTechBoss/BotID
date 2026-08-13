// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Tier, VerificationContext} from "../libraries/Types.sol";
import {Digest} from "../libraries/Digest.sol";
import {IVerificationAdapter} from "../interfaces/IVerificationAdapter.sol";

/// @title SignatureAdapter — Bronze tier
/// @notice The agent operator signs the execution context. Trust comes from the bond and the
///         challenge window, not from cryptography.
/// @dev Deliberately weak on its own, and that is the point. Bronze costs nothing to produce,
///      works for any model including LLM agents, and is only honest because the operator is
///      staking a slashable bond on a claim anyone can escalate to a Gold proof. An agent that
///      cannot answer a challenge loses far more than it gains by lying.
contract SignatureAdapter is IVerificationAdapter {
    function tier() external pure returns (Tier) {
        return Tier.Bronze;
    }

    function verify(VerificationContext calldata ctx, bytes calldata attestation)
        external
        view
        returns (bool)
    {
        if (attestation.length != 65) return false;

        bytes32 digest = Digest.execution(ctx, address(this));

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(attestation.offset)
            s := calldataload(add(attestation.offset, 0x20))
            v := byte(0, calldataload(add(attestation.offset, 0x40)))
        }
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            return false;
        }
        if (v != 27 && v != 28) return false;

        address signer = ecrecover(digest, v, r, s);
        return signer != address(0) && signer == ctx.operator;
    }
}

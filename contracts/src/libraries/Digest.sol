// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {VerificationContext} from "./Types.sol";

/// @notice Canonical EIP-712 digest of an execution context.
/// @dev Every adapter binds *this* digest, so no attestation is valid for any other request,
///      agent, model, input set, or output. Dropping a field here reintroduces one of the
///      attacks the redesign closes, so the struct is hashed whole.
///
///      The `\x19\x01` envelope is not decoration, and its absence was a real defect rather
///      than a stylistic one. Domain separation by chain id, verifying contract and typehash
///      was always here, so nothing was ever forgeable; two other things followed anyway.
///      A signer could not render what it was agreeing to — an operator approving a delivery
///      saw one opaque word, not a request id and a deadline — so every attestation in the
///      protocol was a blind sign. And a key that signs bare 32-byte hashes has given up the
///      one structural guarantee that its signatures cannot also be *transactions*: the `\x19`
///      prefixes exist to keep the signable spaces disjoint, because an RLP-encoded transaction
///      never begins with that byte.
///
///      **Analogy:** the envelope is the letterhead. The same sentence carries a different
///      weight on a blank sheet and on a sheet naming the company, the department and the date
///      — and whoever holds a signed blank sheet gets to decide later what was agreed.
library Digest {
    bytes32 internal constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    /// @dev Hashed at compile time. Both are part of the domain, so changing either invalidates
    ///      every signature issued under the old pair. That is what `version` is *for*, and why
    ///      it is a deliberate string rather than a number nobody thinks about: the next change
    ///      to the field list should bump it, and the old signatures should stop verifying on
    ///      the same block rather than lingering in an ambiguous middle state.
    bytes32 internal constant DOMAIN_NAME = keccak256("BotID");
    bytes32 internal constant DOMAIN_VERSION = keccak256("1");

    bytes32 internal constant EXECUTION_TYPEHASH = keccak256(
        "Execution(bytes32 requestId,uint256 agentId,bytes32 modelCommitment,bytes32 inputCommitment,bytes32 outputCommitment,uint64 deliverBy)"
    );

    /// @notice The EIP-712 domain separator for a given verifying contract.
    /// @dev `block.chainid` is read live rather than cached in an immutable at construction.
    ///      Caching it is the usual gas optimisation and it is deliberately declined: the saving
    ///      is one keccak over five words, and the cost is that every signature stays valid on
    ///      both sides of a chain split, which is a replay class that only appears on the one
    ///      day nobody is looking for it.
    function domainSeparator(address verifyingContract) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN_TYPEHASH, DOMAIN_NAME, DOMAIN_VERSION, block.chainid, verifyingContract
            )
        );
    }

    /// @notice `keccak256(0x1901 || domainSeparator || structHash)` — the bytes a signer signs.
    function toTypedDataHash(address verifyingContract, bytes32 structHash)
        internal
        view
        returns (bytes32)
    {
        return
            keccak256(abi.encodePacked(hex"1901", domainSeparator(verifyingContract), structHash));
    }

    function execution(VerificationContext memory ctx, address verifier)
        internal
        view
        returns (bytes32)
    {
        // The chain id and the verifier address used to sit inside this hash. They are in the
        // domain now, which is where EIP-712 puts them and which is why the envelope can be
        // added without touching the field list — `EXECUTION_TYPEHASH` is byte-for-byte the
        // string it has always been. Both values still bind the signature exactly as before;
        // they have moved, not gone.
        bytes32 structHash = keccak256(
            abi.encode(
                EXECUTION_TYPEHASH,
                ctx.requestId,
                ctx.agentId,
                ctx.modelCommitment,
                ctx.inputCommitment,
                ctx.outputCommitment,
                ctx.deliverBy
            )
        );
        return toTypedDataHash(verifier, structHash);
    }
}

/// @notice The two standard domain getters, for any contract that verifies a signature.
/// @dev A mixin rather than three copies. Every contract that is a `verifyingContract` needs to
///      answer the same two questions, and the answers must agree with `Digest` exactly — so
///      they are derived from it here once, where a change cannot reach one adapter and miss
///      another. `InputAttestor`, `SignatureAdapter` and `TeeAdapter` inherit it.
///
///      This is the half of the EIP-712 fix that tooling consumes. The envelope makes a message
///      *renderable*; these make the domain *discoverable*, so a signer does not have to be told
///      the name and version out of band and then trusted to have been told correctly.
abstract contract EIP712Domain {
    /// @notice The domain separator this contract verifies signatures under.
    /// @dev Also what lets the relayer check its own envelope at startup. It previously asserted
    ///      only `FEED_TYPEHASH` and had nothing to compare the rest against, so a drift in name,
    ///      version or address would have silently produced signatures valid for nothing.
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return Digest.domainSeparator(address(this));
    }

    /// @notice ERC-5267 domain discovery.
    /// @dev `fields` is 0x0f: name, version, chainId and verifyingContract are present; salt and
    ///      extensions are not.
    function eip712Domain()
        external
        view
        returns (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,
            bytes32 salt,
            uint256[] memory extensions
        )
    {
        return (hex"0f", "BotID", "1", block.chainid, address(this), bytes32(0), new uint256[](0));
    }
}

/// @notice Adds the execution digest itself to the domain getters, for adapters that verify one.
/// @dev This exists to make the off-chain mirror *checkable*. `Digest` is a library, so its
///      typehash has no on-chain getter, and the relayer's startup check had a hole it could only
///      acknowledge in a comment: it asserted `FEED_TYPEHASH` against the attestor and then wrote
///      `void EXECUTION_TYPEHASH;` because there was nothing to compare the execution side
///      against. A pure view that returns the finished digest closes it completely — the relayer
///      can now hand a context to the deployed adapter and compare the answer with its own,
///      which tests the envelope, the domain and the field list in one call rather than testing
///      one constant and trusting the rest.
///
///      **Analogy:** the difference between checking that two people were issued the same
///      dictionary and checking that they translate the same sentence the same way.
abstract contract ExecutionVerifier is EIP712Domain {
    /// @notice The exact bytes an attestation for `ctx` must be signed over at this adapter.
    function executionDigest(VerificationContext calldata ctx) external view returns (bytes32) {
        return Digest.execution(ctx, address(this));
    }
}

// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Digest, EIP712Domain} from "./libraries/Digest.sol";
import {Ownable} from "./libraries/Utils.sol";
import {IInputAttestor} from "./interfaces/IInputAttestor.sol";

/// @title InputAttestor
/// @notice Verifies that an agent's declared inputs came from attested publishers.
/// @dev This contract exists because a proof of inference is not a proof of honesty. `ezkl`
///      proves "this committed model, run on these inputs, produced this output". It says
///      nothing about where the inputs came from. Without this check an agent can feed itself
///      a fabricated price, produce a flawless proof, and execute a flawless theft.
///
///      A request's `inputCommitment` is the hash of a bundle of feed readings, each signed by
///      a quorum of registered publishers and each fresh relative to the execution deadline.
///      The same commitment is bound into the verification artifact by the adapter, so the
///      inputs the agent proved over are provably the inputs the consumer commissioned.
contract InputAttestor is IInputAttestor, Ownable, EIP712Domain {
    bytes32 public constant FEED_TYPEHASH =
        keccak256("FeedReading(bytes32 feedId,bytes32 valueHash,uint64 timestamp)");

    mapping(address => bool) public publishers;
    uint256 public publisherCount;
    uint256 public quorum = 1;
    uint64 public maxAge = 5 minutes;

    error InvalidParameter();

    event PublisherSet(address indexed publisher, bool allowed);
    event QuorumSet(uint256 quorum, uint64 maxAge);

    constructor(address initialOwner) Ownable(initialOwner) {}

    function setPublisher(address publisher, bool allowed) external onlyOwner {
        if (publishers[publisher] == allowed) return;
        publishers[publisher] = allowed;
        publisherCount = allowed ? publisherCount + 1 : publisherCount - 1;
        emit PublisherSet(publisher, allowed);
    }

    function setQuorum(uint256 quorum_, uint64 maxAge_) external onlyOwner {
        if (quorum_ == 0 || quorum_ > publisherCount || maxAge_ == 0) revert InvalidParameter();
        quorum = quorum_;
        maxAge = maxAge_;
        emit QuorumSet(quorum_, maxAge_);
    }

    /// @notice The EIP-712 digest a publisher signs for a single feed reading.
    /// @dev The chain id and this address moved out of the struct hash and into the domain, so
    ///      `FEED_TYPEHASH` is unchanged and still describes exactly the three fields signed.
    ///      Both values still bind the signature; they are one level up.
    function feedDigest(bytes32 feedId, bytes32 valueHash, uint64 timestamp)
        public
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(FEED_TYPEHASH, feedId, valueHash, timestamp));
        return Digest.toTypedDataHash(address(this), structHash);
    }

    /// @notice Canonical commitment over an ordered bundle of feed readings.
    /// @dev Consumers compute this off-chain and put it in the request. Order is significant.
    function commit(FeedAttestation[] memory feeds) public view override returns (bytes32) {
        bytes32[] memory leaves = new bytes32[](feeds.length);
        for (uint256 i; i < feeds.length; ++i) {
            leaves[i] = feedDigest(feeds[i].feedId, feeds[i].valueHash, feeds[i].timestamp);
        }
        return keccak256(abi.encode(leaves));
    }

    /// @inheritdoc IInputAttestor
    function verifyInputs(bytes32 inputCommitment, bytes calldata bundle, uint64 asOf)
        external
        view
        returns (bool)
    {
        FeedAttestation[] memory feeds = abi.decode(bundle, (FeedAttestation[]));
        if (feeds.length == 0) return false;

        uint256 q = quorum;
        for (uint256 i; i < feeds.length; ++i) {
            FeedAttestation memory f = feeds[i];

            // Fresh relative to the execution deadline, and not from the future.
            if (f.timestamp > asOf) return false;
            if (asOf - f.timestamp > maxAge) return false;

            bytes32 digest = feedDigest(f.feedId, f.valueHash, f.timestamp);

            // Signers must be strictly ascending — cheap dedup, so one publisher cannot
            // sign a reading `quorum` times and satisfy the threshold alone.
            address last = address(0);
            uint256 valid;
            for (uint256 j; j < f.signatures.length; ++j) {
                address signer = _tryRecover(digest, f.signatures[j]);
                if (signer == address(0) || signer <= last || !publishers[signer]) return false;
                last = signer;
                unchecked {
                    ++valid;
                }
            }
            if (valid < q) return false;
        }

        return commit(feeds) == inputCommitment;
    }

    /// @dev Non-reverting recover: this is a `view` returning a bool, and a malformed signature
    ///      should surface as "not attested", not as an opaque revert inside the router.
    function _tryRecover(bytes32 digest, bytes memory signature) private pure returns (address) {
        if (signature.length != 65) return address(0);

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            return address(0);
        }
        if (v != 27 && v != 28) return address(0);
        return ecrecover(digest, v, r, s);
    }
}

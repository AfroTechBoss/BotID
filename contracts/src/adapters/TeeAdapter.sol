// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Tier, VerificationContext} from "../libraries/Types.sol";
import {Digest, ExecutionVerifier} from "../libraries/Digest.sol";
import {Ownable} from "../libraries/Utils.sol";
import {IVerificationAdapter} from "../interfaces/IVerificationAdapter.sol";

/// @title TeeAdapter — Silver tier
/// @notice Verifies that an execution was signed inside an enclave running allowlisted code.
///
/// @dev Silver is what makes the protocol relevant to LLM-driven agents. ZK-ML today proves
///      small numeric models — MLPs, gradient-boosted trees, logistic regression. It cannot
///      prove a language-model agent at any price. A ZK-only protocol therefore addresses a
///      sliver of the market it claims. TEE attestation covers arbitrary code at effectively
///      zero marginal cost, with a weaker but real trust assumption: the silicon vendor.
///
///      Honest limitation: full parsing of an AWS Nitro / SGX attestation document on chain is
///      prohibitively expensive. This adapter instead verifies signatures from *enrolled
///      enclave keys*, where enrolment is performed by notaries who check the attestation
///      document off chain and bind (enclaveKey → measurement, expiry) here. The trust
///      assumption is therefore the notary set plus the vendor, and enrolments are short-lived
///      by design. Migrating enrolment to on-chain document verification is a drop-in change to
///      this contract that touches nothing else.
contract TeeAdapter is IVerificationAdapter, Ownable, ExecutionVerifier {
    struct Enrolment {
        bytes32 measurement; // PCR0 / MRENCLAVE of the code the enclave is running
        uint64 expiresAt;
    }

    mapping(bytes32 => bool) public allowedMeasurements;
    mapping(address => Enrolment) public enrolments;
    mapping(address => bool) public notaries;

    /// @notice Maximum lifetime of an enrolment. Short by design: a leaked enclave key must
    ///         stop being useful quickly, without relying on revocation being noticed in time.
    uint64 public constant MAX_ENROLMENT = 7 days;

    error NotNotary();
    error InvalidParameter();

    event NotarySet(address indexed notary, bool allowed);
    event MeasurementSet(bytes32 indexed measurement, bool allowed);
    event EnclaveEnrolled(address indexed enclaveKey, bytes32 indexed measurement, uint64 expiresAt);
    event EnclaveRevoked(address indexed enclaveKey);

    constructor(address initialOwner) Ownable(initialOwner) {}

    modifier onlyNotary() {
        if (!notaries[msg.sender]) revert NotNotary();
        _;
    }

    function tier() external pure returns (Tier) {
        return Tier.Silver;
    }

    /// @inheritdoc IVerificationAdapter
    /// @dev Unconditionally true. Enrolment is keyed by enclave key rather than by model, so
    ///      capability here is a property of the signer and not of the commitment — and the
    ///      signer is not knowable until the attestation arrives. Answering per-model would
    ///      require a registry this adapter deliberately does not keep.
    function canVerify(bytes32) external pure returns (bool) {
        return true;
    }

    function setNotary(address notary, bool allowed) external onlyOwner {
        notaries[notary] = allowed;
        emit NotarySet(notary, allowed);
    }

    function setMeasurement(bytes32 measurement, bool allowed) external onlyOwner {
        allowedMeasurements[measurement] = allowed;
        emit MeasurementSet(measurement, allowed);
    }

    function enroll(address enclaveKey, bytes32 measurement, uint64 expiresAt) external onlyNotary {
        if (enclaveKey == address(0) || !allowedMeasurements[measurement]) revert InvalidParameter();
        if (expiresAt <= block.timestamp || expiresAt > block.timestamp + MAX_ENROLMENT) {
            revert InvalidParameter();
        }
        enrolments[enclaveKey] = Enrolment({measurement: measurement, expiresAt: expiresAt});
        emit EnclaveEnrolled(enclaveKey, measurement, expiresAt);
    }

    /// @dev Callable by any notary, immediately, without owner action — revocation must be
    ///      faster than enrolment, not slower.
    function revoke(address enclaveKey) external onlyNotary {
        delete enrolments[enclaveKey];
        emit EnclaveRevoked(enclaveKey);
    }

    function verify(VerificationContext calldata ctx, bytes calldata attestation)
        external
        view
        returns (bool)
    {
        (address enclaveKey, bytes memory signature) = abi.decode(attestation, (address, bytes));
        if (signature.length != 65) return false;

        Enrolment memory e = enrolments[enclaveKey];
        if (e.expiresAt <= block.timestamp) return false;
        if (!allowedMeasurements[e.measurement]) return false;

        bytes32 digest =
            keccak256(abi.encode(Digest.execution(ctx, address(this)), e.measurement));

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            return false;
        }
        if (v != 27 && v != 28) return false;

        return ecrecover(digest, v, r, s) == enclaveKey;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Tier, VerificationContext} from "../libraries/Types.sol";
import {Ownable} from "../libraries/Utils.sol";
import {IInputAttestor} from "../interfaces/IInputAttestor.sol";
import {IVerificationAdapter} from "../interfaces/IVerificationAdapter.sol";

/// @notice ABI of the verifier contract emitted by `ezkl create-evm-verifier`.
interface IEzklVerifier {
    function verifyProof(bytes calldata proof, uint256[] calldata instances)
        external
        view
        returns (bool);
}

/// @title ZkAdapter — Gold tier
/// @notice Verifies a Groth16 proof and, critically, that the values it ran on are the values
///         the consumer commissioned and the values the agent delivered.
///
/// @dev **A proof alone is not enough.** A verifier returning `true` says "this circuit was
///      evaluated on *some* public instances". It says nothing about which request those
///      instances describe. So the adapter's job is not to call `verifyProof` — it is to pin
///      the instance vector to `ctx` before doing so.
///
///      ## Instance layout
///
///          instances[0 .. nIn)          model input tensor
///          instances[nIn .. nIn + nOut) model output tensor
///
///      That is exactly what `ezkl` emits for a single-input circuit compiled with
///      `--input-visibility public --output-visibility public`: the input cells, then the
///      output cells, as bn254 field elements. There is no protocol-specific prologue, and
///      that is deliberate — see "Why the commitments are not in the circuit" below.
///
///      `nIn` is not supplied by the agent. It is the length of `reveals`, and `reveals` is
///      pinned by `ctx.inputCommitment`, so the split point between inputs and outputs is
///      fixed by the consumer's own commitment rather than by the party being checked.
///
///      ## Why the commitments are not in the circuit
///
///      The obvious design puts `inputCommitment` and `outputCommitment` in the public
///      instances. It cannot be built. Both are `keccak256` commitments, and a halo2 circuit
///      cannot compute keccak over an ABI encoding without a keccak gadget that `ezkl` does
///      not expose — proving one would cost more than the model.
///
///      Binding them on chain is both cheaper and stronger. Keccak costs 6 gas a word here,
///      and the check is against the router's own storage rather than against a number the
///      prover chose. Nothing is lost: `requestId` and `agentId` do not need to appear in the
///      instances either, because a proof is only reusable across two requests that share a
///      model, an input commitment *and* an output commitment — and for those two requests it
///      is asserting the identical, true statement.
///
///      ## Revealing values
///
///      An input bundle commits to `valueHash`, not to a number, so the circuit's input cells
///      cannot be compared to it directly. The protocol therefore fixes the preimage:
///
///          valueHash = keccak256(abi.encode(int256 value, bytes32 salt))
///
///      `value` is a whole number at the model's declared decimal scale — a price in cents, a
///      rate in basis points. The salt keeps the reading private until it is revealed here,
///      which matters because an input commitment is public from the moment the request is
///      made.
///
///      ## The fixed-point shift
///
///      `ezkl` quantises inputs to `value << inputScaleBits`, and that shifted number is what
///      lands in the instance cell. The shift is registered per model alongside the verifier
///      because it cannot be inferred and it cannot be zero for any interesting model: at
///      scale 0 a division's reciprocal quantises to zero and the circuit silently computes
///      nothing. Making it a registration parameter is what lets the Gold tier accept models
///      that divide — normalisation, softmax, attention — instead of only those that do not.
///
///      A wrong shift is not a security hole; it is a liveness one. Every honest proof for
///      that model is rejected until the owner corrects it, which is the safe direction to
///      fail in.
contract ZkAdapter is IVerificationAdapter, Ownable {
    /// @notice The bn254 scalar field. `ezkl` emits instances as elements of it, so a negative
    ///         fixed-point value `-x` arrives as `P - x`.
    uint256 internal constant P =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    /// @notice Shifted values outside ±2^128 are rejected before they are mapped into the field.
    /// @dev Without this a value just below `P` would encode as a small positive field element,
    ///      letting a reveal claim one number and the circuit see another. No fixed-point
    ///      quantisation produces magnitudes anywhere near this bound, so nothing honest is
    ///      excluded.
    int256 internal constant MAX_ABS = int256(1) << 128;

    /// @notice Ceiling on the registered shift. Well above any usable `ezkl` scale, and low
    ///         enough that `value << bits` cannot be made to overflow.
    uint8 internal constant MAX_SCALE_BITS = 64;

    /// @notice A feed value opened against the `valueHash` the publishers signed.
    struct Reveal {
        bytes32 feedId;
        uint64 timestamp;
        int256 value;
        bytes32 salt;
    }

    /// @notice A registered circuit: its on-chain verifier and the fixed-point shift its
    ///         public input cells are quantised by.
    struct Model {
        IEzklVerifier verifier;
        uint8 inputScaleBits;
    }

    /// @notice One circuit per model commitment. A model change means a new circuit, a new
    ///         verifying key, and a new agent id — reputation does not transfer.
    mapping(bytes32 => Model) public modelFor;

    /// @notice Source of the commitment convention. Must be the same attestor the router uses;
    ///         a mismatch makes every honest Gold proof fail closed rather than open.
    IInputAttestor public inputAttestor;

    error InvalidParameter();

    event VerifierSet(bytes32 indexed modelCommitment, address verifier, uint8 inputScaleBits);
    event InputAttestorSet(address attestor);

    constructor(address initialOwner, IInputAttestor attestor) Ownable(initialOwner) {
        inputAttestor = attestor;
        emit InputAttestorSet(address(attestor));
    }

    function tier() external pure returns (Tier) {
        return Tier.Gold;
    }

    /// @param inputScaleBits The circuit's `input_scale`. Read it from the model's
    ///        `settings.json`; guessing it makes every proof for this model fail closed.
    function setVerifier(bytes32 modelCommitment, IEzklVerifier verifier, uint8 inputScaleBits)
        external
        onlyOwner
    {
        if (modelCommitment == bytes32(0)) revert InvalidParameter();
        if (inputScaleBits > MAX_SCALE_BITS) revert InvalidParameter();
        modelFor[modelCommitment] = Model(verifier, inputScaleBits);
        emit VerifierSet(modelCommitment, address(verifier), inputScaleBits);
    }

    function setInputAttestor(IInputAttestor attestor) external onlyOwner {
        inputAttestor = attestor;
        emit InputAttestorSet(address(attestor));
    }

    /// @inheritdoc IVerificationAdapter
    /// @param attestation `abi.encode(bytes proof, uint256[] instances, Reveal[] reveals)`.
    function verify(VerificationContext calldata ctx, bytes calldata attestation)
        external
        view
        returns (bool)
    {
        Model memory model = modelFor[ctx.modelCommitment];
        if (address(model.verifier) == address(0)) return false;

        (bytes memory proof, uint256[] memory instances, Reveal[] memory reveals) =
            abi.decode(attestation, (bytes, uint256[], Reveal[]));

        // A circuit with no inputs proves nothing about the request, and one with no outputs
        // has nothing to commit to.
        uint256 nIn = reveals.length;
        if (nIn == 0 || instances.length <= nIn) return false;

        if (!_bindsInputs(ctx, instances, reveals, model.inputScaleBits)) return false;
        if (!_bindsOutputs(ctx, instances, nIn)) return false;

        // Bubble a reverting verifier up as `false` rather than as an opaque failure.
        try model.verifier.verifyProof(proof, instances) returns (bool ok) {
            return ok;
        } catch {
            return false;
        }
    }

    /// @notice The commitment a set of reveals produces. Provers use this to check their own
    ///         bundle before spending minutes on a proof that was never going to bind.
    function inputCommitmentFor(Reveal[] calldata reveals) external view returns (bytes32) {
        return _commit(reveals);
    }

    /// @notice The input half of the instance vector a circuit must expose for these reveals.
    function expectedInputInstances(bytes32 modelCommitment, Reveal[] calldata reveals)
        external
        view
        returns (uint256[] memory out)
    {
        uint8 bits = modelFor[modelCommitment].inputScaleBits;
        out = new uint256[](reveals.length);
        for (uint256 i; i < reveals.length; ++i) {
            (bool ok, uint256 f) = _toField(reveals[i].value, bits);
            if (!ok) revert InvalidParameter();
            out[i] = f;
        }
    }

    /// @notice The commitment `commitOutputs` in the relayer, and the circuit's output cells,
    ///         must agree on.
    function outputCommitmentFor(uint256[] calldata outputs) external pure returns (bytes32) {
        return keccak256(abi.encode(outputs));
    }

    // ---------------------------------------------------------------- internals

    /// @dev The reveals must reproduce the consumer's `inputCommitment` exactly, and the
    ///      circuit's input cells must be those revealed values in the same order. Together
    ///      these say: the model ran on the data the consumer commissioned, and nothing else.
    function _bindsInputs(
        VerificationContext calldata ctx,
        uint256[] memory instances,
        Reveal[] memory reveals,
        uint8 bits
    ) private view returns (bool) {
        if (_commit(reveals) != ctx.inputCommitment) return false;

        for (uint256 i; i < reveals.length; ++i) {
            (bool ok, uint256 f) = _toField(reveals[i].value, bits);
            if (!ok || instances[i] != f) return false;
        }
        return true;
    }

    /// @dev The tail of the instance vector is the model's output tensor, and it must hash to
    ///      the `outputCommitment` the agent is delivering under. This is what stops a correct
    ///      proof from being paired with a different, more flattering result.
    function _bindsOutputs(
        VerificationContext calldata ctx,
        uint256[] memory instances,
        uint256 nIn
    ) private pure returns (bool) {
        uint256[] memory outputs = new uint256[](instances.length - nIn);
        for (uint256 i; i < outputs.length; ++i) {
            outputs[i] = instances[nIn + i];
        }
        return keccak256(abi.encode(outputs)) == ctx.outputCommitment;
    }

    /// @dev Re-derives the bundle commitment from opened values, delegating the hashing
    ///      convention to the attestor so the two can never drift apart. Signatures are left
    ///      empty: the router already checked the quorum against this same commitment at
    ///      delivery, so re-checking them here would only re-prove a settled fact.
    function _commit(Reveal[] memory reveals) private view returns (bytes32) {
        IInputAttestor.FeedAttestation[] memory feeds =
            new IInputAttestor.FeedAttestation[](reveals.length);

        for (uint256 i; i < reveals.length; ++i) {
            feeds[i] = IInputAttestor.FeedAttestation({
                feedId: reveals[i].feedId,
                valueHash: keccak256(abi.encode(reveals[i].value, reveals[i].salt)),
                timestamp: reveals[i].timestamp,
                signatures: new bytes[](0)
            });
        }
        return inputAttestor.commit(feeds);
    }

    /// @dev A revealed value into the bn254 field element `ezkl` puts in the instance cell:
    ///      quantise by the model's shift, then fold negatives around the modulus.
    function _toField(int256 v, uint8 bits) private pure returns (bool ok, uint256 f) {
        if (bits > MAX_SCALE_BITS) return (false, 0);

        // Bound the value *before* shifting, so the shift itself cannot overflow and so a
        // magnitude near the modulus can never be reduced onto a small, innocent-looking one.
        int256 limit = MAX_ABS >> bits;
        if (v >= limit || v <= -limit) return (false, 0);

        int256 scaled = v << bits;
        return (true, scaled >= 0 ? uint256(scaled) : P - uint256(-scaled));
    }
}

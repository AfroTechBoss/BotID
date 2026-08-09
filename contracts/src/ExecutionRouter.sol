// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Outcome, Request, Status, Tier, VerificationContext} from "./libraries/Types.sol";
import {IERC20, Ownable, SafeTransfer} from "./libraries/Utils.sol";
import {AgentRegistry} from "./AgentRegistry.sol";
import {FaultKind, IReputationEngine} from "./interfaces/IReputationEngine.sol";
import {IInputAttestor} from "./interfaces/IInputAttestor.sol";
import {IVerificationAdapter} from "./interfaces/IVerificationAdapter.sol";

/// @title ExecutionRouter
/// @notice The full execution lifecycle: request → deliver → (challenge) → finalize → settle.
/// @dev Three properties of this contract are the substance of the redesign:
///
///      1. Executions are *requested by consumers*, not self-submitted by agents. The consumer
///         supplies `inputCommitment`, so an agent cannot choose its own inputs, and every
///         execution carries a unique `requestId` bound into the attestation — no replay,
///         no cross-request substitution, no permissionless score inflation.
///
///      2. Non-delivery is a first-class fault. In the v0 design the only negative signal was
///         a failed proof, which never lands on chain because it reverts. Here the negative
///         signal is a request that was accepted and not honoured, which is what actually
///         happens when an agent fails.
///
///      3. Cheap tiers are made honest by escalation, not by trust. A Bronze or Silver delivery
///         can be challenged, and the agent must then produce a Gold-tier proof of the same
///         execution or be slashed.
contract ExecutionRouter is Ownable {
    using SafeTransfer for IERC20;

    IERC20 public immutable bondToken;
    AgentRegistry public immutable registry;
    IReputationEngine public immutable engine;
    IInputAttestor public inputAttestor;

    mapping(Tier => IVerificationAdapter) public adapters;

    uint64 public challengeWindow = 1 hours;
    uint64 public escalationWindow = 6 hours;
    uint64 public settlementWindow = 7 days;
    uint256 public challengeBondAmount = 100e18;
    uint32 public faultSlashBps = 2_000; // of remaining bond, on a lost challenge
    uint32 public livenessSlashBps = 200; // of remaining bond, on non-delivery
    uint32 public challengerBountyBps = 5_000; // of the slashed amount
    uint32 public protocolFeeBps = 500; // of the execution fee

    /// @notice Floor on `fee`, in bps of `notional`.
    /// @dev The protocol's take is a cut of `fee`, which the consumer sets freely — so without a
    ///      floor a consumer and an agent who know each other set `fee = 0`, settle off chain,
    ///      and take the service for nothing. `notional` is the one quantity in a request that
    ///      is expensive to misreport in either direction: it is capped by the agent's
    ///      bond-derived credit, and it is the weight of the score update, so understating it
    ///      costs the agent reputation while overstating it consumes its own credit.
    ///      Settable to zero, which is the right value while bootstrapping and on testnets.
    uint32 public minFeeBps = 10; // 0.1% of notional

    address public treasury;

    uint256 private _nonce;
    uint256 private _locked = 1;
    mapping(bytes32 => Request) private _requests;

    error Reentrancy();
    error UnknownRequest();
    error BadStatus();
    error NotOperator();
    error NotConsumer();
    error DeadlinePassed();
    error DeadlineNotPassed();
    error InputAttestationFailed();
    error VerificationFailed();
    error NoAdapter();
    error InvalidParameter();
    error FeeBelowFloor();

    event ExecutionRequested(
        bytes32 indexed requestId,
        uint256 indexed agentId,
        address indexed consumer,
        bytes32 inputCommitment,
        uint256 notional,
        uint256 fee,
        uint64 deliverBy,
        string inputURI
    );
    event ExecutionDelivered(
        bytes32 indexed requestId, uint256 indexed agentId, bytes32 outputCommitment, Tier tier
    );
    event ExecutionChallenged(bytes32 indexed requestId, address indexed challenger);
    event ChallengeResolved(bytes32 indexed requestId, address indexed challenger, uint256 bondToAgent);
    event ExecutionFaulted(bytes32 indexed requestId, uint256 indexed agentId, uint256 slashed);
    event ExecutionFinalized(bytes32 indexed requestId, Tier tier);
    event ExecutionSettled(bytes32 indexed requestId, uint256 indexed agentId, int256 realizedPnlBps);
    event ExecutionExpired(bytes32 indexed requestId, uint256 indexed agentId, uint256 slashed);
    event AdapterSet(Tier indexed tier, address adapter);
    event ParametersUpdated();

    constructor(
        address initialOwner,
        AgentRegistry registry_,
        IReputationEngine engine_,
        IERC20 bondToken_,
        IInputAttestor inputAttestor_,
        address treasury_
    ) Ownable(initialOwner) {
        registry = registry_;
        engine = engine_;
        bondToken = bondToken_;
        inputAttestor = inputAttestor_;
        treasury = treasury_;
    }

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    // ---------------------------------------------------------------- admin

    function setAdapter(Tier tier, IVerificationAdapter adapter) external onlyOwner {
        if (tier == Tier.None) revert InvalidParameter();
        if (address(adapter) != address(0) && adapter.tier() != tier) revert InvalidParameter();
        adapters[tier] = adapter;
        emit AdapterSet(tier, address(adapter));
    }

    function setInputAttestor(IInputAttestor attestor) external onlyOwner {
        inputAttestor = attestor;
    }

    /// @notice Set the fee floor, in bps of notional. Zero disables it.
    /// @dev Kept off `setParameters` because it is an economic lever, tuned on a different
    ///      cadence from the safety windows, and because a governance call that has to restate
    ///      all eight of those to change one number invites transcription mistakes.
    ///      Capped well below 10_000: a floor near 100% of notional is not a fee, it is a halt,
    ///      and it would brick `requestExecution` in a way that looks like an unrelated bug.
    function setMinFeeBps(uint32 minFeeBps_) external onlyOwner {
        if (minFeeBps_ > 1_000) revert InvalidParameter();
        minFeeBps = minFeeBps_;
        emit ParametersUpdated();
    }

    function setParameters(
        uint64 challengeWindow_,
        uint64 escalationWindow_,
        uint64 settlementWindow_,
        uint256 challengeBondAmount_,
        uint32 faultSlashBps_,
        uint32 livenessSlashBps_,
        uint32 challengerBountyBps_,
        uint32 protocolFeeBps_
    ) external onlyOwner {
        if (
            faultSlashBps_ > 10_000 || livenessSlashBps_ > 10_000 || challengerBountyBps_ > 10_000
                || protocolFeeBps_ > 10_000
        ) revert InvalidParameter();
        // The settlement window must stay comfortably inside the unbonding period, or an agent
        // could withdraw its bond before the outcomes it is responsible for are recorded.
        if (settlementWindow_ + escalationWindow_ >= registry.UNBONDING_PERIOD()) {
            revert InvalidParameter();
        }
        challengeWindow = challengeWindow_;
        escalationWindow = escalationWindow_;
        settlementWindow = settlementWindow_;
        challengeBondAmount = challengeBondAmount_;
        faultSlashBps = faultSlashBps_;
        livenessSlashBps = livenessSlashBps_;
        challengerBountyBps = challengerBountyBps_;
        protocolFeeBps = protocolFeeBps_;
        emit ParametersUpdated();
    }

    // ---------------------------------------------------------------- phase B: request

    /// @notice A consumer protocol commissions an execution from a specific agent.
    /// @param inputCommitment Commitment to the attested input bundle. Supplied by the
    ///        *consumer*: the agent must not be able to pick the data it is judged on.
    /// @param notional Capital this execution puts at risk. Checked against the agent's
    ///        bond-derived credit limit, and used as the weight of the eventual score update.
    /// @param inputURI Where the agent can fetch the bundle behind `inputCommitment`. Emitted
    ///        only — never stored, never trusted. A commitment is not a locator, so without
    ///        this the agent has no way to obtain the data it is being asked to run on. The
    ///        agent must still check the bundle it fetches hashes to `inputCommitment`; a
    ///        hostile URI can therefore waste its time but never change what it is judged on.
    function requestExecution(
        uint256 agentId,
        bytes32 inputCommitment,
        uint128 notional,
        uint128 fee,
        uint64 deliverBy,
        string calldata inputURI
    ) external nonReentrant returns (bytes32 requestId) {
        if (deliverBy <= block.timestamp) revert DeadlinePassed();

        // Price the work against notional, not against a number the counterparties agree on
        // privately. See `minFeeBps`.
        if (fee < (uint256(notional) * minFeeBps) / 10_000) revert FeeBelowFloor();

        requestId = keccak256(abi.encode(block.chainid, address(this), _nonce++));

        registry.reserve(agentId, notional);

        _requests[requestId] = Request({
            consumer: msg.sender,
            agentId: agentId,
            inputCommitment: inputCommitment,
            outputCommitment: bytes32(0),
            notional: notional,
            fee: fee,
            createdAt: uint64(block.timestamp),
            deliverBy: deliverBy,
            finalizeAt: 0,
            settleBy: 0,
            tier: Tier.None,
            status: Status.Pending,
            challenger: address(0),
            challengeBond: 0,
            escalationDeadline: 0
        });

        if (fee != 0) bondToken.safeTransferFrom(msg.sender, address(this), fee);

        emit ExecutionRequested(
            requestId, agentId, msg.sender, inputCommitment, notional, fee, deliverBy, inputURI
        );
    }

    // ---------------------------------------------------------------- phase C: deliver

    /// @param inputBundle Publisher-signed feed data. Must hash to the request's
    ///        `inputCommitment` — this is what stops an agent from proving a correct run over
    ///        fabricated inputs, which a bare inference proof does not.
    /// @param attestation Tier-specific artifact: EIP-712 signature, TEE quote, or ZK proof.
    function deliver(
        bytes32 requestId,
        bytes32 outputCommitment,
        bytes calldata inputBundle,
        bytes calldata attestation
    ) external nonReentrant {
        Request storage r = _load(requestId);
        if (r.status != Status.Pending) revert BadStatus();
        if (block.timestamp > r.deliverBy) revert DeadlinePassed();

        AgentRegistry.Agent memory agent = registry.getAgent(r.agentId);
        if (msg.sender != agent.operator) revert NotOperator();

        // Freshness is judged at the moment the consumer commissioned the work, not at
        // delivery. The consumer fixes the data when it sets `inputCommitment`, so that is the
        // only point at which "how stale is this reading" is a meaningful question. How long
        // the agent may then sit on it is `deliverBy`'s job, not the attestor's.
        if (!inputAttestor.verifyInputs(r.inputCommitment, inputBundle, r.createdAt)) {
            revert InputAttestationFailed();
        }

        _verify(r, agent, requestId, outputCommitment, agent.tier, attestation);

        r.outputCommitment = outputCommitment;
        r.tier = agent.tier;
        r.settleBy = uint64(block.timestamp) + settlementWindow;

        if (agent.tier == Tier.Gold) {
            // A valid ZK proof needs no challenge period.
            r.status = Status.Finalized;
            r.finalizeAt = uint64(block.timestamp);
            emit ExecutionFinalized(requestId, Tier.Gold);
        } else {
            r.status = Status.Delivered;
            r.finalizeAt = uint64(block.timestamp) + challengeWindow;
        }

        emit ExecutionDelivered(requestId, r.agentId, outputCommitment, agent.tier);
    }

    function _verify(
        Request storage r,
        AgentRegistry.Agent memory agent,
        bytes32 requestId,
        bytes32 outputCommitment,
        Tier tier,
        bytes calldata attestation
    ) private view {
        IVerificationAdapter adapter = adapters[tier];
        if (address(adapter) == address(0)) revert NoAdapter();

        VerificationContext memory ctx = VerificationContext({
            requestId: requestId,
            agentId: r.agentId,
            modelCommitment: agent.modelCommitment,
            inputCommitment: r.inputCommitment,
            outputCommitment: outputCommitment,
            deliverBy: r.deliverBy,
            operator: agent.operator
        });

        if (!adapter.verify(ctx, attestation)) revert VerificationFailed();
    }

    // ---------------------------------------------------------------- phase D: challenge

    /// @notice Challenge a Bronze/Silver delivery. The agent must escalate to a Gold proof.
    function challenge(bytes32 requestId) external nonReentrant {
        Request storage r = _load(requestId);
        if (r.status != Status.Delivered) revert BadStatus();
        if (block.timestamp >= r.finalizeAt) revert DeadlinePassed();

        r.status = Status.Challenged;
        r.challenger = msg.sender;
        r.challengeBond = uint128(challengeBondAmount);
        r.escalationDeadline = uint64(block.timestamp) + escalationWindow;

        if (challengeBondAmount != 0) {
            bondToken.safeTransferFrom(msg.sender, address(this), challengeBondAmount);
        }

        emit ExecutionChallenged(requestId, msg.sender);
    }

    /// @notice Agent answers a challenge with a Gold-tier proof of the same execution.
    /// @dev The challenger's bond goes to the agent owner, so frivolous challenges are costly.
    function resolveChallenge(bytes32 requestId, bytes calldata zkProof) external nonReentrant {
        Request storage r = _load(requestId);
        if (r.status != Status.Challenged) revert BadStatus();
        if (block.timestamp > r.escalationDeadline) revert DeadlinePassed();

        AgentRegistry.Agent memory agent = registry.getAgent(r.agentId);
        if (msg.sender != agent.operator) revert NotOperator();

        _verify(r, agent, requestId, r.outputCommitment, Tier.Gold, zkProof);

        uint256 bond = r.challengeBond;
        address challenger = r.challenger;

        r.status = Status.Finalized;
        r.tier = Tier.Gold;
        r.challengeBond = 0;

        if (bond != 0) bondToken.safeTransfer(agent.owner, bond);

        emit ChallengeResolved(requestId, challenger, bond);
        emit ExecutionFinalized(requestId, Tier.Gold);
    }

    /// @notice No proof arrived in time. Slash the agent, pay the challenger, refund the consumer.
    function slashUnresolvedChallenge(bytes32 requestId) external nonReentrant {
        Request storage r = _load(requestId);
        if (r.status != Status.Challenged) revert BadStatus();
        if (block.timestamp <= r.escalationDeadline) revert DeadlineNotPassed();

        r.status = Status.Faulted;

        uint256 slashed = _slash(r.agentId, faultSlashBps, r.challenger);
        engine.recordFault(r.agentId, FaultKind.Verification);
        registry.release(r.agentId, r.notional);

        uint256 bond = r.challengeBond;
        r.challengeBond = 0;
        if (bond != 0) bondToken.safeTransfer(r.challenger, bond);
        if (r.fee != 0) bondToken.safeTransfer(r.consumer, r.fee);

        emit ExecutionFaulted(requestId, r.agentId, slashed);
    }

    function finalize(bytes32 requestId) external {
        Request storage r = _load(requestId);
        if (r.status != Status.Delivered) revert BadStatus();
        if (block.timestamp < r.finalizeAt) revert DeadlineNotPassed();
        r.status = Status.Finalized;
        emit ExecutionFinalized(requestId, r.tier);
    }

    // ---------------------------------------------------------------- phase E: settle

    /// @notice Consumer reports the economic result. This is the signal reputation is built on.
    function settle(bytes32 requestId, Outcome calldata outcome) external nonReentrant {
        Request storage r = _load(requestId);
        if (r.status != Status.Finalized) revert BadStatus();
        if (msg.sender != r.consumer) revert NotConsumer();
        if (block.timestamp > r.settleBy) revert DeadlinePassed();
        _settle(requestId, r, outcome);
    }

    /// @notice Settle at par once the window lapses, so a silent consumer cannot hold an
    ///         agent's exposure and fee hostage indefinitely.
    function settleDefault(bytes32 requestId) external nonReentrant {
        Request storage r = _load(requestId);
        if (r.status != Status.Finalized) revert BadStatus();
        if (block.timestamp <= r.settleBy) revert DeadlineNotPassed();
        _settle(
            requestId, r, Outcome({realizedPnlBps: 0, slaBreached: false, limitBreached: false})
        );
    }

    function _settle(bytes32 requestId, Request storage r, Outcome memory outcome) private {
        r.status = Status.Settled;

        AgentRegistry.Agent memory agent = registry.getAgent(r.agentId);
        registry.release(r.agentId, r.notional);
        engine.recordOutcome(r.agentId, outcome, r.notional, agent.lossToleranceBps);

        uint256 fee = r.fee;
        if (fee != 0) {
            uint256 protocolCut = (fee * protocolFeeBps) / 10_000;
            if (protocolCut != 0) bondToken.safeTransfer(treasury, protocolCut);
            bondToken.safeTransfer(agent.owner, fee - protocolCut);
        }

        emit ExecutionSettled(requestId, r.agentId, outcome.realizedPnlBps);
    }

    /// @notice The agent accepted a request and never delivered. Permissionless to call.
    /// @dev This is the fault the v0 design had no way to observe.
    function markExpired(bytes32 requestId) external nonReentrant {
        Request storage r = _load(requestId);
        if (r.status != Status.Pending) revert BadStatus();
        if (block.timestamp <= r.deliverBy) revert DeadlineNotPassed();

        r.status = Status.Expired;

        uint256 slashed = _slash(r.agentId, livenessSlashBps, msg.sender);
        engine.recordFault(r.agentId, FaultKind.Liveness);
        registry.release(r.agentId, r.notional);

        if (r.fee != 0) bondToken.safeTransfer(r.consumer, r.fee);

        emit ExecutionExpired(requestId, r.agentId, slashed);
    }

    // ---------------------------------------------------------------- internals

    function _slash(uint256 agentId, uint32 bps, address bountyRecipient)
        private
        returns (uint256)
    {
        uint256 bond = registry.getAgent(agentId).bond;
        uint256 amount = (bond * bps) / 10_000;
        if (amount == 0) return 0;
        uint256 bounty = (amount * challengerBountyBps) / 10_000;
        return registry.slash(agentId, amount, bountyRecipient, bounty);
    }

    function _load(bytes32 requestId) private view returns (Request storage r) {
        r = _requests[requestId];
        if (r.status == Status.None) revert UnknownRequest();
    }

    function getRequest(bytes32 requestId) external view returns (Request memory) {
        return _requests[requestId];
    }
}

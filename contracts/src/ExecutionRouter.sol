// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Outcome, Request, Status, Tier, VerificationContext} from "./libraries/Types.sol";
import {IERC20, Ownable, SafeTransfer, Timelocked} from "./libraries/Utils.sol";
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
///         happens when an agent fails. Acceptance has to be real for that to be fair, so an
///         operator may decline a request at order time (`reject`) and every request must allow
///         a deliverable window (`minDeliveryWindow`) — otherwise "did not honour it" collapses
///         into "was named in it", and the fault becomes a weapon anyone can point at any agent.
///
///      3. Cheap tiers are made honest by escalation, not by trust. A Bronze or Silver delivery
///         can be challenged, and the agent must then produce a Gold-tier proof of the same
///         execution or be slashed.
contract ExecutionRouter is Timelocked {
    using SafeTransfer for IERC20;

    IERC20 public immutable bondToken;
    AgentRegistry public immutable registry;
    IReputationEngine public immutable engine;
    IInputAttestor public inputAttestor;

    mapping(Tier => IVerificationAdapter) public adapters;

    uint64 public challengeWindow = 1 hours;
    uint64 public escalationWindow = 6 hours;
    uint64 public settlementWindow = 7 days;

    /// @notice Shortest delivery window a request may specify, measured from its own creation.
    /// @dev Without a floor here `deliverBy` may be the very next block, and *every* request is
    ///      undeliverable by construction — the agent is slashed for a deadline no operator
    ///      could have met. That is true even of a request that is honest in every other
    ///      respect, so no amount of validation on `inputCommitment` substitutes for it.
    uint64 public minDeliveryWindow = 15 minutes;

    /// @notice How long after creation an operator may decline a request. See `reject`.
    /// @dev Must stay strictly below `minDeliveryWindow`, so the right to decline always
    ///      expires before the earliest deadline a request could carry.
    uint64 public rejectionWindow = 5 minutes;
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
    error DeliveryWindowTooShort();
    error ZeroNotional();
    error NotEscalatable();
    error SelfDealing();

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
    event ExecutionRejected(
        bytes32 indexed requestId, uint256 indexed agentId, address indexed consumer
    );
    event AdapterSet(Tier indexed tier, address adapter);
    event InputAttestorSet(address indexed attestor);
    event AdapterQueued(Tier indexed tier, address adapter, uint64 eta);
    event InputAttestorQueued(address indexed attestor, uint64 eta);
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

    /// @dev An adapter *is* the verification. Swapping the Bronze adapter for one whose `verify`
    ///      returns true unconditionally does not look like theft in any event this contract
    ///      emits — every delivery afterwards is simply accepted, and every challenge against one
    ///      loses. This is the single most valuable thing the owner key can do, so it is the one
    ///      the notice period exists for.
    function queueAdapter(Tier tier, IVerificationAdapter adapter) external {
        emit AdapterQueued(tier, address(adapter), _queue(_adapterAction(tier, adapter)));
    }

    function setAdapter(Tier tier, IVerificationAdapter adapter) external onlyOwner {
        _consume(_adapterAction(tier, adapter));
        if (tier == Tier.None) revert InvalidParameter();
        if (address(adapter) != address(0) && adapter.tier() != tier) revert InvalidParameter();
        adapters[tier] = adapter;
        emit AdapterSet(tier, address(adapter));
    }

    /// @dev The attestor decides whether the inputs an execution claims were really published.
    ///      An attestor that accepts anything lets an agent pick its inputs after the fact, which
    ///      is the stale-input attack the commitment scheme exists to prevent.
    function queueInputAttestor(IInputAttestor attestor) external {
        emit InputAttestorQueued(address(attestor), _queue(_attestorAction(attestor)));
    }

    /// @dev Emitted now. This setter previously changed where every input bundle is checked and
    ///      left no trace but the getter.
    function setInputAttestor(IInputAttestor attestor) external onlyOwner {
        _consume(_attestorAction(attestor));
        inputAttestor = attestor;
        emit InputAttestorSet(address(attestor));
    }

    /// @notice The action id `queueAdapter(tier, adapter)` produces, and `cancel` expects.
    function adapterAction(Tier tier, IVerificationAdapter adapter) external pure returns (bytes32) {
        return _adapterAction(tier, adapter);
    }

    /// @notice The action id `queueInputAttestor(attestor)` produces. See `adapterAction`.
    function inputAttestorAction(IInputAttestor attestor) external pure returns (bytes32) {
        return _attestorAction(attestor);
    }

    function _adapterAction(Tier tier, IVerificationAdapter adapter) private pure returns (bytes32) {
        return keccak256(abi.encode(this.setAdapter.selector, tier, address(adapter)));
    }

    function _attestorAction(IInputAttestor attestor) private pure returns (bytes32) {
        return keccak256(abi.encode(this.setInputAttestor.selector, address(attestor)));
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

    /// @notice Set the floor on a request's delivery window, and the operator's window to decline.
    /// @dev Kept off `setParameters` for the reason given on `setMinFeeBps`, and because these
    ///      two are the only parameters with an invariant *between* them: `rejectionWindow_`
    ///      must be strictly shorter than `minDeliveryWindow_`. Setting them in one call is what
    ///      makes that invariant checkable at all — as two separate setters there would be an
    ///      ordering in which governance passes through a state that violates it.
    ///
    ///      Both must be non-zero. A zero `minDeliveryWindow_` restores the next-block deadline
    ///      that made every request undeliverable; a zero `rejectionWindow_` leaves the agent
    ///      with no way to decline. Either one alone reopens the griefing vector, so neither is
    ///      offered as a way to switch the mechanism off.
    function setDeliveryWindows(uint64 minDeliveryWindow_, uint64 rejectionWindow_)
        external
        onlyOwner
    {
        if (minDeliveryWindow_ == 0 || rejectionWindow_ == 0) revert InvalidParameter();
        if (rejectionWindow_ >= minDeliveryWindow_) revert InvalidParameter();
        minDeliveryWindow = minDeliveryWindow_;
        rejectionWindow = rejectionWindow_;
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
        // `challenge` collects the full uint256 but records `uint128(challengeBondAmount)`, and
        // every refund path pays out the recorded field. Above 2^128 those two disagree and the
        // difference is gone — not refunded, not recoverable, and not visible in any event,
        // because a truncating cast is silent by construction. The bound is enforced here rather
        // than at the cast so the failure lands on the governance call that is wrong, where it
        // can still be corrected, instead of on the first challenger to post a bond.
        if (challengeBondAmount_ > type(uint128).max) revert InvalidParameter();
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
    /// @dev The agent's own owner and operator keys may not commission its work. That is a
    ///      narrow check and it is worth being precise about what it does and does not buy.
    ///
    ///      It does not stop self-dealing. Nothing on chain can: the owner deploys a second
    ///      address, funds it, and hires itself through that, and the two are indistinguishable
    ///      from an arms-length consumer. What it stops is self-dealing that costs *nothing extra
    ///      to attempt* — the single-key case, where the whole cycle of commission, deliver and
    ///      report a flawless outcome runs from the address that also owns the agent. The
    ///      economics are handled elsewhere and properly, by `ReputationEngine.weightPerFeeUnit`:
    ///      every fabricated execution's influence is bought with a protocol fee that does not
    ///      come back, so a farm of consumer addresses buys exactly as much voice as one address
    ///      paying the same total. This check is the cheap half — it makes the laziest version of
    ///      the attack fail loudly rather than settle quietly, and it costs one storage read.
    function requestExecution(
        uint256 agentId,
        bytes32 inputCommitment,
        uint128 notional,
        uint128 fee,
        uint64 deliverBy,
        string calldata inputURI
    ) external nonReentrant returns (bytes32 requestId) {
        // Not merely "in the future" — far enough into it that an operator could actually have
        // delivered. See `minDeliveryWindow`.
        if (deliverBy < block.timestamp + minDeliveryWindow) revert DeliveryWindowTooShort();

        // A request with nothing at risk still opens a live, still-slashable obligation, but
        // `reserve(agentId, 0)` adds nothing to `openNotional` — and `openNotional == 0` is the
        // whole of the outstanding-liability gate on `AgentRegistry.withdrawEarly`. A consumer
        // could therefore park a zero-notional request against an agent, watch it walk out with
        // its bond, and leave `_slash` computing a percentage of nothing. The gate reads
        // `openNotional` as a proxy for "no open requests", so this is what makes the proxy
        // faithful: every live request now contributes to the number the gate looks at.
        if (notional == 0) revert ZeroNotional();

        // Price the work against notional, not against a number the counterparties agree on
        // privately. See `minFeeBps`.
        if (fee < (uint256(notional) * minFeeBps) / 10_000) revert FeeBelowFloor();

        // See the note above: the one-key case only.
        AgentRegistry.Agent memory agent = registry.getAgent(agentId);
        if (msg.sender == agent.owner || msg.sender == agent.operator) revert SelfDealing();

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
            attributed: false,
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

        uint256 originator =
            _verifyAndAttribute(r, agent, requestId, outputCommitment, agent.tier, attestation);

        // Verified, and produced by this agent rather than merely presented by it. The two come
        // apart only on the Gold path — see `IVerificationAdapter.verifyAndAttribute` — and when
        // they do, the delivery still stands: the output is correct, the consumer gets it, the
        // agent gets paid. What it does not get is credit. `_settle` weights the score update at
        // zero, and the tier is not recorded as demonstrated, because presenting a proof someone
        // else produced demonstrates possession and not capability.
        bool attributed = originator == r.agentId;
        r.attributed = attributed;
        if (attributed) registry.recordDelivery(r.agentId, agent.tier);

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

    /// @dev The one verification entry point, used by both `deliver` and `resolveChallenge`.
    ///      Non-view, because the Gold adapter records who first presented a given proof and that
    ///      record is the whole point — see `ZkAdapter.verifyAndAttribute`.
    ///
    ///      Note what it deliberately does not do: a duplicate never reverts. Answering a challenge
    ///      is how an agent avoids a slash, so it must not be possible for a *different* agent, on
    ///      a *different* request, to make that answer fail. A copied proof still establishes the
    ///      statement, so it still ends the challenge; it just does not earn anything.
    /// @return originator The agent credited with producing the work, which is `r.agentId` on every
    ///         path except a Gold proof that had already been presented by somebody else.
    function _verifyAndAttribute(
        Request storage r,
        AgentRegistry.Agent memory agent,
        bytes32 requestId,
        bytes32 outputCommitment,
        Tier tier,
        bytes calldata attestation
    ) private returns (uint256 originator) {
        IVerificationAdapter adapter = _adapter(tier);
        bool ok;
        (ok, originator) = adapter.verifyAndAttribute(
            _context(r, agent, requestId, outputCommitment), attestation
        );
        if (!ok) revert VerificationFailed();
    }

    function _adapter(Tier tier) private view returns (IVerificationAdapter adapter) {
        adapter = adapters[tier];
        if (address(adapter) == address(0)) revert NoAdapter();
    }

    function _context(
        Request storage r,
        AgentRegistry.Agent memory agent,
        bytes32 requestId,
        bytes32 outputCommitment
    ) private view returns (VerificationContext memory) {
        return VerificationContext({
            requestId: requestId,
            agentId: r.agentId,
            modelCommitment: agent.modelCommitment,
            inputCommitment: r.inputCommitment,
            outputCommitment: outputCommitment,
            deliverBy: r.deliverBy,
            operator: agent.operator
        });
    }

    // ---------------------------------------------------------------- phase D: challenge

    /// @notice Whether `agentId` could answer a challenge with a Gold proof today.
    /// @dev Read this before challenging, and before hiring: an agent that answers false has
    ///      deliveries nobody can dispute, which is a real thing to know about it either way.
    ///      False when no Gold adapter is set at all, since then no delivery is escalatable.
    function canEscalate(uint256 agentId) public view returns (bool) {
        IVerificationAdapter gold = adapters[Tier.Gold];
        if (address(gold) == address(0)) return false;
        return gold.canVerify(registry.getAgent(agentId).modelCommitment);
    }

    /// @notice Challenge a Bronze/Silver delivery. The agent must escalate to a Gold proof.
    /// @dev Permissionless and deliberately so — a challenge anyone can raise is what makes a
    ///      Bronze signature worth anything. But that only holds where escalation is possible.
    ///      Against an agent with no registered circuit the sequence is: pay
    ///      `challengeBondAmount`, wait out `escalationWindow`, collect `challengerBountyBps` of
    ///      a `faultSlashBps` slash and get the bond back — profitable, repeatable, and it
    ///      establishes nothing about the delivery, because the agent's failure to produce a
    ///      proof was structural rather than evidence of a lie. So the gate below is not a
    ///      convenience for agents; without it `challenge` is a paid weapon rather than a check.
    ///
    ///      Read live rather than snapshotted at delivery, which errs the safe way in both
    ///      directions: an agent whose circuit is de-registered after delivering stops being
    ///      challengeable rather than becoming free to slash, and one that registers a circuit
    ///      afterwards becomes challengeable exactly when it can answer.
    function challenge(bytes32 requestId) external nonReentrant {
        Request storage r = _load(requestId);
        if (r.status != Status.Delivered) revert BadStatus();
        if (block.timestamp >= r.finalizeAt) revert DeadlinePassed();
        if (!canEscalate(r.agentId)) revert NotEscalatable();

        r.status = Status.Challenged;
        r.challenger = msg.sender;
        // Safe: `setParameters` holds `challengeBondAmount` inside uint128, which is what makes
        // the amount collected below and the amount refunded later the same number.
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

        uint256 originator =
            _verifyAndAttribute(r, agent, requestId, r.outputCommitment, Tier.Gold, zkProof);

        // Winning a challenge with a proof this agent actually produced is a Gold demonstration in
        // the fullest sense — it is the escalation the tier exists for. Winning with somebody
        // else's proof still clears the challenge, for the reason in `_verifyAndAttribute`, but it
        // is not evidence the agent can produce one, so it does not raise the tier.
        if (originator == r.agentId) registry.recordDelivery(r.agentId, Tier.Gold);

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
        // A reported outcome is evidence, weighted by the capital that was at risk behind it.
        _settle(requestId, r, outcome, r.notional);
    }

    /// @notice Settle at par once the window lapses, so a silent consumer cannot hold an
    ///         agent's exposure and fee hostage indefinitely.
    /// @dev Releases exposure and pays the fee exactly as `settle` does, but records the
    ///      observation at zero weight — the score comes out of this untouched.
    ///
    ///      The distinction matters because a zeroed `Outcome` is not neutral input to
    ///      `ScoreMath.quality`: it starts at MAX_SCORE and only ever subtracts, so no loss, no
    ///      SLA breach and no limit breach scores a flat 10,000. Feeding that in at full
    ///      `notional` weight made a consumer's silence the strongest positive signal the
    ///      protocol can emit, and an agent could manufacture it at will by commissioning its
    ///      own work through an address that then never settles. Reputation was buyable for the
    ///      fee and the wait.
    ///
    ///      Zero weight is the honest encoding rather than a patch: `ScoreMath.observe` already
    ///      returns the score unchanged when weight is zero, so this reuses a designed path, and
    ///      "the counterparty never reported" is an absence of evidence rather than evidence of
    ///      quality. The work still happened and was verified, so it still counts as activity —
    ///      `settledExecutions` increments and `lastActiveAt` is stamped as usual.
    function settleDefault(bytes32 requestId) external nonReentrant {
        Request storage r = _load(requestId);
        if (r.status != Status.Finalized) revert BadStatus();
        if (block.timestamp <= r.settleBy) revert DeadlineNotPassed();
        _settle(
            requestId, r, Outcome({realizedPnlBps: 0, slaBreached: false, limitBreached: false}), 0
        );
    }

    /// @param scoreWeight Capital to weight the reputation observation by. Normally `r.notional`;
    ///        zero on paths where `outcome` is a placeholder nobody attested to.
    function _settle(
        bytes32 requestId,
        Request storage r,
        Outcome memory outcome,
        uint256 scoreWeight
    ) private {
        r.status = Status.Settled;

        AgentRegistry.Agent memory agent = registry.getAgent(r.agentId);
        registry.release(r.agentId, r.notional);

        // Computed before the outcome is recorded, because the engine prices the consumer's
        // influence in it — the fee has to be known to the score update, not merely paid after it.
        uint256 fee = r.fee;
        uint256 protocolCut = (fee * protocolFeeBps) / 10_000;

        // An unattributed delivery is paid and settled exactly like any other and moves the score
        // by nothing. See `deliver`: the work is real, the credit is not this agent's.
        engine.recordOutcome(
            r.agentId,
            r.consumer,
            outcome,
            r.attributed ? scoreWeight : 0,
            agent.lossToleranceBps,
            protocolCut
        );

        if (fee != 0) {
            if (protocolCut != 0) bondToken.safeTransfer(treasury, protocolCut);
            bondToken.safeTransfer(agent.owner, fee - protocolCut);
        }

        emit ExecutionSettled(requestId, r.agentId, outcome.realizedPnlBps);
    }

    /// @notice The operator declines a request it will not serve. No fault, no slash.
    /// @dev `requestExecution` is permissionless and takes `inputCommitment` on trust — it is a
    ///      bare bytes32, and nothing on chain can tell a commitment to a real publisher-signed
    ///      bundle from a number someone invented. A request built on an invented commitment can
    ///      never satisfy `deliver`'s attestation check, so before this function existed such a
    ///      request was undeliverable by construction, and the agent named in it had no answer:
    ///      it could not deliver, and it could not decline. Anyone could therefore mint a
    ///      liveness fault against any active agent for the price of gas, collect
    ///      `challengerBountyBps` of the resulting slash by calling `markExpired` themselves,
    ///      and repeat. The fault was recorded against the agent for a failure that was not the
    ///      agent's, and `ReputationEngine` deliberately does not let volume dilute a fault, so
    ///      there was no recovering from it either.
    ///
    ///      The defence is the right to decline, and it has to be time-boxed to be honest.
    ///      Rejection is open only for `rejectionWindow` after creation — a decision made at
    ///      *order* time, before the agent has learned anything about how the run would have
    ///      gone. An unbounded right to decline would be a different thing entirely: an agent
    ///      would sit on a request until it could see it was going to miss, then reject at
    ///      `deliverBy - 1`, and `markExpired` would never fire again.
    ///
    ///      Analogy: a market maker may decline to quote, but may not withdraw a quote it has
    ///      already filled. Declining is free; reneging is what the liveness fault is for.
    ///
    ///      The `deliverBy` bound is redundant while `rejectionWindow < minDeliveryWindow`, which
    ///      `setDeliveryWindows` enforces. It is here anyway because that invariant binds the
    ///      parameters at the time they are set, not the requests already in flight: widening
    ///      `rejectionWindow` would otherwise hand every open request a retroactive escape from a
    ///      deadline it had already blown.
    function reject(bytes32 requestId) external nonReentrant {
        Request storage r = _load(requestId);
        if (r.status != Status.Pending) revert BadStatus();
        if (msg.sender != registry.getAgent(r.agentId).operator) revert NotOperator();
        if (block.timestamp > r.createdAt + rejectionWindow) revert DeadlinePassed();
        if (block.timestamp > r.deliverBy) revert DeadlinePassed();

        r.status = Status.Rejected;
        registry.release(r.agentId, r.notional);

        if (r.fee != 0) bondToken.safeTransfer(r.consumer, r.fee);

        emit ExecutionRejected(requestId, r.agentId, r.consumer);
    }

    /// @notice The agent accepted a request and never delivered. Permissionless to call.
    /// @dev This is the fault the v0 design had no way to observe.
    ///
    ///      "Accepted" now means something it did not before: the operator had `rejectionWindow`
    ///      to decline this request and did not take it. See `reject`.
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

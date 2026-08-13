// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Policy, Profile, Tier} from "./libraries/Types.sol";
import {IERC20, Ownable, SafeTransfer} from "./libraries/Utils.sol";
import {IReputationEngine} from "./interfaces/IReputationEngine.sol";
import {IReputationOracle} from "./interfaces/IReputationOracle.sol";

/// @title AgentRegistry
/// @notice Agent identity, bonded capital, exposure limits and the consumer-facing read API.
/// @dev The central economic invariant lives here:
///
///        maxOpenNotional(agent) = effectiveBond × leverage(score) × tierFactor
///
///      Reputation is a *multiplier on posted capital*, never a substitute for it. This bounds
///      what any identity — including a farm of cheap Sybil identities — can extract, because
///      extraction capacity scales with capital the attacker has actually locked and can lose.
contract AgentRegistry is IReputationOracle, Ownable {
    using SafeTransfer for IERC20;

    struct Agent {
        address owner;
        address operator; // key that signs deliveries; rotatable without losing history
        bytes32 modelCommitment; // weightsHash ‖ vkHash ‖ declared limits — immutable
        Tier tier;
        bool active;
        uint32 lossToleranceBps; // downside the agent declares as within-spec
        uint256 bond;
        uint256 openNotional;
        uint256 unbondingAmount;
        uint64 unbondingAt;
    }

    IERC20 public immutable bondToken;
    IReputationEngine public immutable engine;

    /// @notice Withdrawal delay. Must exceed the longest settlement window so an agent cannot
    ///         exit ahead of the settlement of its own outstanding executions.
    uint64 public constant UNBONDING_PERIOD = 21 days;

    uint256 public minBond = 500e18;
    uint256 public globalNotionalCap = 5_000_000e18;

    /// @notice Price of leaving before `UNBONDING_PERIOD` elapses, in bps of the unbonding amount.
    /// @dev Read the caveat on `withdrawEarly` before changing this. It is a *toll*, not a
    ///      deterrent: 10% of bond is smaller than a single fault slash, so it does not price
    ///      escape from an outcome an agent already expects to lose.
    uint32 public earlyExitPenaltyBps = 1_000;
    address public router;
    address public treasury;

    uint256 private _nextAgentId = 1;
    mapping(uint256 => Agent) private _agents;
    mapping(address => uint256) public agentIdByOperator;

    error NotRouter();
    error NotAgentOwner();
    error UnknownAgent();
    error AgentInactive();
    error OperatorInUse();
    error BondTooLow();
    error CreditExceeded();
    error NothingToWithdraw();
    error UnbondingNotElapsed();
    error UnbondingElapsed();
    error OutstandingLiability();
    error InvalidParameter();

    event AgentRegistered(
        uint256 indexed agentId,
        address indexed owner,
        address indexed operator,
        Tier tier,
        bytes32 modelCommitment,
        uint256 bond
    );
    event OperatorRotated(uint256 indexed agentId, address indexed from, address indexed to);
    event BondIncreased(uint256 indexed agentId, uint256 amount, uint256 total);
    event UnbondingStarted(uint256 indexed agentId, uint256 amount, uint64 availableAt);
    event Withdrawn(uint256 indexed agentId, uint256 amount);
    event WithdrawnEarly(uint256 indexed agentId, uint256 paid, uint256 penalty);
    event Slashed(uint256 indexed agentId, uint256 amount, address indexed recipient);
    event ExposureChanged(uint256 indexed agentId, uint256 openNotional);
    event ActiveSet(uint256 indexed agentId, bool active);
    event RouterSet(address indexed router);

    constructor(address initialOwner, IERC20 bondToken_, IReputationEngine engine_, address treasury_)
        Ownable(initialOwner)
    {
        bondToken = bondToken_;
        engine = engine_;
        treasury = treasury_;
    }

    modifier onlyRouter() {
        if (msg.sender != router) revert NotRouter();
        _;
    }

    modifier onlyAgentOwner(uint256 agentId) {
        if (_agents[agentId].owner != msg.sender) revert NotAgentOwner();
        _;
    }

    // ---------------------------------------------------------------- admin

    function setRouter(address router_) external onlyOwner {
        router = router_;
        emit RouterSet(router_);
    }

    function setTreasury(address treasury_) external onlyOwner {
        treasury = treasury_;
    }

    function setLimits(uint256 minBond_, uint256 globalNotionalCap_) external onlyOwner {
        if (minBond_ == 0 || globalNotionalCap_ == 0) revert InvalidParameter();
        minBond = minBond_;
        globalNotionalCap = globalNotionalCap_;
    }

    function setEarlyExitPenaltyBps(uint32 bps) external onlyOwner {
        if (bps > 10_000) revert InvalidParameter();
        earlyExitPenaltyBps = bps;
    }

    // ---------------------------------------------------------------- lifecycle

    function registerAgent(
        address operator,
        bytes32 modelCommitment,
        Tier tier,
        uint32 lossToleranceBps,
        uint256 bondAmount
    ) external returns (uint256 agentId) {
        if (bondAmount < minBond) revert BondTooLow();
        if (operator == address(0) || agentIdByOperator[operator] != 0) revert OperatorInUse();
        if (tier == Tier.None || lossToleranceBps > 10_000) revert InvalidParameter();

        agentId = _nextAgentId++;
        _agents[agentId] = Agent({
            owner: msg.sender,
            operator: operator,
            modelCommitment: modelCommitment,
            tier: tier,
            active: true,
            lossToleranceBps: lossToleranceBps,
            bond: bondAmount,
            openNotional: 0,
            unbondingAmount: 0,
            unbondingAt: 0
        });
        agentIdByOperator[operator] = agentId;

        bondToken.safeTransferFrom(msg.sender, address(this), bondAmount);
        engine.initAgent(agentId);

        emit AgentRegistered(agentId, msg.sender, operator, tier, modelCommitment, bondAmount);
    }

    /// @dev The operator key is rotatable; `modelCommitment` is not. Changing the model means
    ///      registering a new agent id, because the reputation was earned by the old one.
    function rotateOperator(uint256 agentId, address newOperator) external onlyAgentOwner(agentId) {
        if (newOperator == address(0) || agentIdByOperator[newOperator] != 0) revert OperatorInUse();
        Agent storage a = _agents[agentId];
        delete agentIdByOperator[a.operator];
        emit OperatorRotated(agentId, a.operator, newOperator);
        a.operator = newOperator;
        agentIdByOperator[newOperator] = agentId;
    }

    function increaseBond(uint256 agentId, uint256 amount) external {
        Agent storage a = _agents[agentId];
        if (a.owner == address(0)) revert UnknownAgent();
        a.bond += amount;
        bondToken.safeTransferFrom(msg.sender, address(this), amount);
        emit BondIncreased(agentId, amount, a.bond);
    }

    function setActive(uint256 agentId, bool active) external onlyAgentOwner(agentId) {
        _agents[agentId].active = active;
        emit ActiveSet(agentId, active);
    }

    function startUnbonding(uint256 agentId, uint256 amount) external onlyAgentOwner(agentId) {
        Agent storage a = _agents[agentId];
        if (amount > a.bond) revert BondTooLow();

        a.unbondingAmount = amount;
        a.unbondingAt = uint64(block.timestamp) + UNBONDING_PERIOD;

        // Credit is computed on bond net of the unbonding amount, so open exposure must still
        // be covered the moment unbonding starts — not only at withdrawal.
        if (a.openNotional > _maxOpenNotional(agentId, a)) revert CreditExceeded();

        emit UnbondingStarted(agentId, amount, a.unbondingAt);
    }

    /// @dev Bond remains slashable for the entire unbonding period. `startUnbonding` only
    ///      removes it from the credit calculation; it does not remove it from risk.
    function withdraw(uint256 agentId) external onlyAgentOwner(agentId) {
        Agent storage a = _agents[agentId];
        uint256 amount = a.unbondingAmount;
        if (amount == 0) revert NothingToWithdraw();
        if (block.timestamp < a.unbondingAt) revert UnbondingNotElapsed();
        if (amount > a.bond) amount = a.bond; // clamped if slashed while unbonding

        a.unbondingAmount = 0;
        a.unbondingAt = 0;
        a.bond -= amount;

        bondToken.safeTransfer(a.owner, amount);
        emit Withdrawn(agentId, amount);
    }

    /// @notice Withdraw before the unbonding period elapses, once nothing is outstanding, paying
    ///         `earlyExitPenaltyBps` of the amount to the treasury.
    /// @dev Two gates, and the second is the one doing the work.
    ///
    ///      `UNBONDING_PERIOD` is not a lock-up. It exists so that outcomes an agent is already
    ///      responsible for can still land against its bond — see the note on `withdraw`. So a
    ///      toll alone would be a price on escaping liability, and the wrong price: a lost
    ///      challenge takes `faultSlashBps` of remaining bond, 20%, while this takes 10% of the
    ///      unbonding amount. An agent expecting a fault would simply pay the smaller number and
    ///      leave, and the payoff it is weighing against comes out of notional, which leverage and
    ///      tier carry to nine times bond. A toll cannot be sized to fix that, because the two
    ///      sides are denominated in different things.
    ///
    ///      So the toll is not asked to. `openNotional == 0` is required, and that condition is
    ///      exactly "no outstanding liability" rather than an approximation of it. The router
    ///      reserves notional in `requestExecution` and releases it in precisely three places —
    ///      `_settle`, `slashUnresolvedChallenge` and `markExpired` — which are the three terminal
    ///      states. Nothing is released at delivery, at `finalize`, or at `resolveChallenge`. So a
    ///      non-zero `openNotional` means the agent still has a request that is Pending, Delivered
    ///      and inside its challenge window, Challenged, or Finalized and awaiting settlement, and
    ///      a zero one means every execution it ever took has already reached a state where the
    ///      bond can no longer be reached for it. There is nothing left to outrun.
    ///
    ///      What remains is a toll on churn, which is what it should have been. Time was standing
    ///      in for a liability check the contract can now make directly; the real chain is
    ///      challengeWindow + escalationWindow + settlementWindow, about seven days, and
    ///      `ExecutionRouter.setParameters` already enforces that it fits inside the 21.
    ///
    ///      The gate is the agent's to clear, not merely to wait out: a Pending request nobody
    ///      expires holds `openNotional` open indefinitely, and `markExpired` is permissionless,
    ///      so an agent blocked here can unblock itself.
    ///
    ///      `penalty` rounds down, so a dust amount can exit free. At six decimals that is a
    ///      millionth of a dollar and not worth a rounding branch.
    function withdrawEarly(uint256 agentId)
        external
        onlyAgentOwner(agentId)
        returns (uint256 paid, uint256 penalty)
    {
        Agent storage a = _agents[agentId];
        uint256 amount = a.unbondingAmount;
        if (amount == 0) revert NothingToWithdraw();
        if (a.openNotional != 0) revert OutstandingLiability();
        // Past the period there is nothing to buy out, and charging for it would make `withdraw`
        // a strictly better call that a caller could miss. Fail loudly and point at the free door.
        if (block.timestamp >= a.unbondingAt) revert UnbondingElapsed();
        if (amount > a.bond) amount = a.bond; // clamped if slashed while unbonding

        penalty = (amount * earlyExitPenaltyBps) / 10_000;
        paid = amount - penalty;

        a.unbondingAmount = 0;
        a.unbondingAt = 0;
        a.bond -= amount;

        if (penalty != 0) bondToken.safeTransfer(treasury, penalty);
        bondToken.safeTransfer(a.owner, paid);
        emit WithdrawnEarly(agentId, paid, penalty);
    }

    // ---------------------------------------------------------------- router hooks

    function reserve(uint256 agentId, uint256 notional) external onlyRouter {
        Agent storage a = _agents[agentId];
        if (a.owner == address(0)) revert UnknownAgent();
        if (!a.active) revert AgentInactive();

        uint256 next = a.openNotional + notional;
        if (next > _maxOpenNotional(agentId, a)) revert CreditExceeded();

        a.openNotional = next;
        emit ExposureChanged(agentId, next);
    }

    function release(uint256 agentId, uint256 notional) external onlyRouter {
        Agent storage a = _agents[agentId];
        a.openNotional = notional > a.openNotional ? 0 : a.openNotional - notional;
        emit ExposureChanged(agentId, a.openNotional);
    }

    /// @notice Slash bond and split it between a bounty recipient and the treasury.
    /// @return slashed The amount actually taken, clamped to the remaining bond.
    function slash(uint256 agentId, uint256 amount, address bountyRecipient, uint256 bounty)
        external
        onlyRouter
        returns (uint256 slashed)
    {
        Agent storage a = _agents[agentId];
        slashed = amount > a.bond ? a.bond : amount;
        if (slashed == 0) return 0;

        a.bond -= slashed;
        if (a.unbondingAmount > a.bond) a.unbondingAmount = a.bond;

        uint256 toBounty = bounty > slashed ? slashed : bounty;
        if (toBounty != 0 && bountyRecipient != address(0)) {
            bondToken.safeTransfer(bountyRecipient, toBounty);
        }
        uint256 remainder = slashed - toBounty;
        if (remainder != 0) bondToken.safeTransfer(treasury, remainder);

        emit Slashed(agentId, slashed, bountyRecipient);
    }

    // ---------------------------------------------------------------- credit

    /// @notice Leverage a score unlocks, in bps. A step function, not continuous — small score
    ///         movements should not silently move an agent's capital ceiling.
    function leverageBps(uint32 score) public pure returns (uint256) {
        if (score < 5_000) return 5_000; // 0.5x — below neutral, undercollateralised is off
        if (score < 7_000) return 10_000; // 1.0x
        if (score < 8_500) return 20_000; // 2.0x
        if (score < 9_500) return 40_000; // 4.0x
        return 60_000; // 6.0x — the cap
    }

    function tierFactorBps(Tier tier) public pure returns (uint256) {
        if (tier == Tier.Gold) return 15_000;
        if (tier == Tier.Silver) return 10_000;
        if (tier == Tier.Bronze) return 5_000;
        return 0;
    }

    function _maxOpenNotional(uint256 agentId, Agent storage a) private view returns (uint256) {
        if (!a.active) return 0;
        uint256 effectiveBond = a.bond > a.unbondingAmount ? a.bond - a.unbondingAmount : 0;
        if (effectiveBond < minBond) return 0;

        uint256 limit = (effectiveBond * leverageBps(engine.getScore(agentId))) / 10_000;
        limit = (limit * tierFactorBps(a.tier)) / 10_000;
        return limit > globalNotionalCap ? globalNotionalCap : limit;
    }

    // ---------------------------------------------------------------- reads

    function getAgent(uint256 agentId) external view returns (Agent memory) {
        return _agents[agentId];
    }

    function getProfile(uint256 agentId) public view returns (Profile memory p) {
        Agent storage a = _agents[agentId];
        (uint32 score, uint32 faults, uint32 settled, uint64 lastActiveAt) = engine.getStats(agentId);
        p = Profile({
            owner: a.owner,
            tier: a.tier,
            score: score,
            faults: faults,
            settledExecutions: settled,
            lastActiveAt: lastActiveAt,
            bond: a.bond,
            openNotional: a.openNotional,
            maxOpenNotional: _maxOpenNotional(agentId, a),
            active: a.active
        });
    }

    function getScore(uint256 agentId) external view returns (uint32) {
        return engine.getScore(agentId);
    }

    function availableCredit(uint256 agentId) external view returns (uint256) {
        Agent storage a = _agents[agentId];
        uint256 max = _maxOpenNotional(agentId, a);
        return max > a.openNotional ? max - a.openNotional : 0;
    }

    /// @notice Whether `withdrawEarly` would succeed right now, and what it would pay out.
    /// @dev So a caller can render the choice rather than discover it by reverting. `penalty` is
    ///      still reported when `allowed` is false, because "you may not leave yet" and "leaving
    ///      costs this much" are different things an operator wants to see at the same time.
    function previewWithdrawEarly(uint256 agentId)
        external
        view
        returns (bool allowed, uint256 paid, uint256 penalty)
    {
        Agent storage a = _agents[agentId];
        uint256 amount = a.unbondingAmount;
        if (amount > a.bond) amount = a.bond;
        penalty = (amount * earlyExitPenaltyBps) / 10_000;
        paid = amount - penalty;
        allowed = amount != 0 && a.openNotional == 0 && block.timestamp < a.unbondingAt;
    }

    function meetsPolicy(uint256 agentId, Policy calldata policy) external view returns (bool) {
        Agent storage a = _agents[agentId];
        if (a.owner == address(0) || !a.active) return false;
        if (a.tier < policy.minTier) return false;
        if (a.bond < policy.minBond) return false;

        (uint32 score, uint32 faults,, uint64 lastActiveAt) = engine.getStats(agentId);
        if (score < policy.minScore) return false;
        if (faults > policy.maxFaults) return false;
        if (
            policy.maxStalenessSeconds != 0
                && block.timestamp > uint256(lastActiveAt) + policy.maxStalenessSeconds
        ) return false;

        return true;
    }

    function operatorOf(uint256 agentId) external view returns (address) {
        return _agents[agentId].operator;
    }
}

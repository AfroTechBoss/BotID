// SPDX-License-Identifier: MIT
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

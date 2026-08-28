// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @notice Minimal transfer helpers tolerant of non-standard ERC20s that return no data.
/// @dev The tolerance is the reason the code check exists. A low-level `call` to an address with
///      no code returns `success = true` and empty returndata — which is byte-for-byte what a
///      well-behaved non-standard token returns on a real transfer. Without `code.length`, this
///      library cannot tell "the token moved your money and said nothing" from "there is no token
///      here at all", and reports both as success. That failure is silent, total and permanent:
///      every deposit, fee and slash appears to work while nothing moves, and the protocol reports
///      bonds it does not hold. One EXTCODESIZE per transfer turns it into a revert at the first
///      deposit instead.
library SafeTransfer {
    error TransferFailed();
    error NotAContract();

    function safeTransfer(IERC20 token, address to, uint256 amount) internal {
        if (address(token).code.length == 0) revert NotAContract();
        (bool ok, bytes memory data) =
            address(token).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function safeTransferFrom(IERC20 token, address from, address to, uint256 amount) internal {
        if (address(token).code.length == 0) revert NotAContract();
        (bool ok, bytes memory data) =
            address(token).call(abi.encodeCall(IERC20.transferFrom, (from, to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}

/// @notice Two-step ownership, so a fat-fingered transfer cannot brick the protocol.
abstract contract Ownable {
    address public owner;
    address public pendingOwner;

    error NotOwner();

    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    constructor(address initialOwner) {
        owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        emit OwnershipTransferred(owner, pendingOwner);
        owner = pendingOwner;
        pendingOwner = address(0);
    }
}

/// @notice A queue-then-execute delay on the handful of setters that can redirect trust.
///
/// @dev This covers a specific and narrow set of powers: the ones that let the owner point a
///      contract at code it did not previously depend on. Rewiring the router, the reputation
///      writers, a verification adapter or the input attestor does not steal anything directly —
///      it substitutes the thing that decides whether an execution was honest. An owner key that
///      can do that instantly can do it faster than an agent can withdraw the bond that would be
///      slashed by it, which is the property this restores.
///
///      The delay is therefore not a general safety margin, it is a *specific* one: it is at least
///      `AgentRegistry.UNBONDING_PERIOD`, so a change anyone objects to can be exited from before
///      it takes effect. Anything shorter would let a rewiring land while the people it affects
///      are still queued to leave.
///
///      Economic parameters are deliberately not covered. A fee floor or a slash percentage moves
///      on a different cadence, is bounded in the setter, and cannot make a dishonest execution
///      verify — putting three weeks between governance and a fee change buys nothing and would
///      just teach everyone to route around the mechanism.
///
///      **Analogy:** a lock's landlord can change the tenancy terms whenever they like, but
///      changing the locks takes notice — long enough that anyone who objects can move out first.
abstract contract Timelocked is Ownable {
    /// @notice How long a queued action must wait. Matches `AgentRegistry.UNBONDING_PERIOD`.
    uint64 public constant TIMELOCK_DELAY = 21 days;

    /// @notice How long after its `eta` a queued action stays executable.
    /// @dev Without an expiry a queue entry is a standing option: an owner could queue a rewiring,
    ///      let the objection pass unremarked, and execute it two years later against an audience
    ///      that has long since stopped watching. The grace window makes a stale plan something
    ///      that has to be announced again.
    uint64 public constant TIMELOCK_GRACE = 14 days;

    /// @notice Earliest execution time of a queued action, by action id. Zero means not queued.
    mapping(bytes32 => uint64) public timelockEta;

    /// @notice Whether the timelock is live. One-way, and false only until deployment finishes.
    /// @dev Wiring a protocol together takes half a dozen calls that all have to land before
    ///      anything works, and there is nothing to protect while none of it is connected — a
    ///      three-week wait between deploying the router and telling the registry about it would
    ///      make deployment impossible rather than safe. So the setters run immediately until
    ///      `finalizeBootstrap()`, which cannot be undone.
    ///
    ///      That this is one-way is the whole guarantee, and it is worth stating what it does not
    ///      guarantee: a deployment that never calls `finalizeBootstrap()` has no timelock at all.
    ///      It is public for exactly that reason — `bootstrapped()` returning false on a live
    ///      deployment is a finding, not a detail.
    bool public bootstrapped;

    error NotQueued();
    error Premature();
    error Stale();
    error AlreadyBootstrapped();

    event ActionQueued(bytes32 indexed action, uint64 eta);
    event ActionCancelled(bytes32 indexed action);
    event Bootstrapped();

    /// @notice Close the deployment window and put the wiring setters behind the delay.
    function finalizeBootstrap() external onlyOwner {
        if (bootstrapped) revert AlreadyBootstrapped();
        bootstrapped = true;
        emit Bootstrapped();
    }

    /// @notice Withdraw a queued action before it executes.
    /// @dev Queueing the wrong address is an ordinary mistake, and without this the only remedy
    ///      would be to wait out the delay and then not execute — leaving a wrong change publicly
    ///      pending for three weeks, which reads exactly like one nobody caught.
    function cancel(bytes32 action) external onlyOwner {
        if (timelockEta[action] == 0) revert NotQueued();
        delete timelockEta[action];
        emit ActionCancelled(action);
    }

    /// @dev Re-queueing a pending action simply restarts its clock.
    function _queue(bytes32 action) internal onlyOwner returns (uint64 eta) {
        eta = uint64(block.timestamp) + TIMELOCK_DELAY;
        timelockEta[action] = eta;
        emit ActionQueued(action, eta);
    }

    /// @dev Consumes the queue entry, so executing an action twice needs announcing it twice.
    function _consume(bytes32 action) internal {
        if (!bootstrapped) return;
        uint64 eta = timelockEta[action];
        if (eta == 0) revert NotQueued();
        if (block.timestamp < eta) revert Premature();
        if (block.timestamp > eta + TIMELOCK_GRACE) revert Stale();
        delete timelockEta[action];
    }
}

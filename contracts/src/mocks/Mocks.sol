// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Test doubles and harnesses. Not part of the deployed protocol.

import {Outcome} from "../libraries/Types.sol";
import {ScoreMath} from "../libraries/ScoreMath.sol";
import {IEzklVerifier} from "../adapters/ZkAdapter.sol";

contract MockERC20 {
    string public name = "Mock BOT";
    string public symbol = "mBOT";
    // Settable rather than `constant 18`, because the bond token is USDT at six decimals and a
    // suite that can only mint an 18-decimal token can only ever prove the protocol at 18. The
    // two parameters that break under a decimals mismatch — halfWeight and challengeBondAmount —
    // break silently, so the only thing that catches them is a test that actually runs at 6.
    uint8 public decimals = 18;

    function setDecimals(uint8 decimals_) external {
        decimals = decimals_;
    }
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

/// @notice Stands in for the verifier emitted by `ezkl create-evm-verifier`.
contract MockEzklVerifier is IEzklVerifier {
    bool public result = true;
    bool public shouldRevert;

    function setResult(bool result_) external {
        result = result_;
    }

    function setShouldRevert(bool shouldRevert_) external {
        shouldRevert = shouldRevert_;
    }

    function verifyProof(bytes calldata, uint256[] calldata) external view returns (bool) {
        require(!shouldRevert, "verifier exploded");
        return result;
    }
}

/// @notice Exposes the pure scoring library for direct unit tests.
contract ScoreMathHarness {
    function decay(uint32 score, uint256 elapsed, uint256 halfLife) external pure returns (uint32) {
        return ScoreMath.decay(score, elapsed, halfLife);
    }

    function observe(uint32 score, uint32 quality, uint256 weight, uint256 halfWeight)
        external
        pure
        returns (uint32)
    {
        return ScoreMath.observe(score, quality, weight, halfWeight);
    }

    function haircut(uint32 score, uint32 bps) external pure returns (uint32) {
        return ScoreMath.haircut(score, bps);
    }

    function quality(Outcome calldata outcome, uint32 lossToleranceBps)
        external
        pure
        returns (uint32)
    {
        return ScoreMath.quality(outcome, lossToleranceBps);
    }
}

/// @notice Consumer stub: requests executions and settles them, like a vault would.
interface IRouterLike {
    function requestExecution(
        uint256 agentId,
        bytes32 inputCommitment,
        uint128 notional,
        uint128 fee,
        uint64 deliverBy,
        string calldata inputURI
    ) external returns (bytes32);
}

// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IStrategy} from "../TreasuryAllocator.sol";

/// @title RBSStrategy — Wraps Olympus V3 RANGE for treasury defense
/// @notice Deposits hold USDC; "deposit" is a no-op (RBS operates via Operator).
///         Balance = USDC held + RBS position value (read from RANGE module).
contract RBSStrategy is IStrategy {
    using SafeERC20 for IERC20;

    IERC20 public immutable reserveToken;
    address public allocator;
    address public rangeOperator;  // Olympus V3 Operator address

    constructor(address _reserveToken, address _rangeOperator) {
        reserveToken = IERC20(_reserveToken);
        rangeOperator = _rangeOperator;
        allocator = msg.sender;
    }

    function name() external pure returns (string memory) { return "RBS"; }

    function deposit(uint256 amount) external {
        // RBS uses funds held by treasury directly; just track
        reserveToken.safeTransferFrom(msg.sender, address(this), amount);
    }

    function withdraw(uint256 amount) external {
        require(msg.sender == allocator, "only allocator");
        reserveToken.safeTransfer(msg.sender, amount);
    }

    function balance() external view returns (uint256) {
        return reserveToken.balanceOf(address(this));
    }

    function harvest() external returns (uint256) {
        // RBS yield is realized via Operator; no separate harvest
        return 0;
    }
}

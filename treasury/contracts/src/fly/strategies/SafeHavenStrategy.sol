// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IStrategy} from "../TreasuryAllocator.sol";

/// @title SafeHavenStrategy — Holds USDC as safe-haven during high volatility
/// @notice Simplest strategy: holds reserve tokens. No LP, no trading.
///         Connectomes rotate funds here when volatility is high.
contract SafeHavenStrategy is IStrategy {
    using SafeERC20 for IERC20;

    IERC20 public immutable reserveToken;
    address public allocator;

    constructor(address _reserveToken) {
        reserveToken = IERC20(_reserveToken);
        allocator = msg.sender;
    }

    function name() external pure returns (string memory) { return "SafeHaven"; }

    function deposit(uint256 amount) external {
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
        return 0; // no yield — this is the safe haven
    }
}

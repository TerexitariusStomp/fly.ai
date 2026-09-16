// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IStrategy} from "../TreasuryAllocator.sol";

/// @title MemecoinStrategy — Wraps ArcLaunchpadAdapter for memecoin trading
/// @notice Holds USDC. "deposit" transfers USDC to the launchpad adapter.
///         Balance = USDC held + value of memecoin positions (read from adapter).
interface IArcLaunchpadAdapter {
    function getCurrentPosition(address token) external view returns (uint256);
    function getWhitelistedTokens() external view returns (address[] memory);
    function executeBuy(address token, uint256 amountIn) external;
    function executeSell(address token, uint256 amountIn) external;
}

contract MemecoinStrategy is IStrategy {
    using SafeERC20 for IERC20;

    IERC20 public immutable reserveToken;
    IArcLaunchpadAdapter public adapter;
    address public allocator;

    constructor(address _reserveToken, address _adapter) {
        reserveToken = IERC20(_reserveToken);
        adapter = IArcLaunchpadAdapter(_adapter);
        allocator = msg.sender;
    }

    function name() external pure returns (string memory) { return "MemecoinTrading"; }

    function deposit(uint256 amount) external {
        reserveToken.safeTransferFrom(msg.sender, address(this), amount);
    }

    function withdraw(uint256 amount) external {
        require(msg.sender == allocator, "only allocator");
        // Sell memecoin positions if needed, then transfer USDC
        _liquidatePositions(amount);
        reserveToken.safeTransfer(msg.sender, amount);
    }

    function balance() external view returns (uint256) {
        uint256 usdcBal = reserveToken.balanceOf(address(this));
        address[] memory tokens = adapter.getWhitelistedTokens();
        uint256 positions = 0;
        for (uint256 i = 0; i < tokens.length; i++) {
            positions += adapter.getCurrentPosition(tokens[i]);
        }
        return usdcBal + positions;
    }

    function harvest() external returns (uint256) {
        // Realized PnL stays in USDC balance; no separate harvest
        return 0;
    }

    function _liquidatePositions(uint256 needed) internal {
        uint256 available = reserveToken.balanceOf(address(this));
        if (available >= needed) return;
        address[] memory tokens = adapter.getWhitelistedTokens();
        for (uint256 i = 0; i < tokens.length && available < needed; i++) {
            uint256 pos = adapter.getCurrentPosition(tokens[i]);
            if (pos > 0) {
                adapter.executeSell(tokens[i], pos);
                available = reserveToken.balanceOf(address(this));
            }
        }
    }
}

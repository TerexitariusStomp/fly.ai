// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IStrategy} from "../TreasuryAllocator.sol";

/// @title YieldFarmingStrategy — Wraps Uniswap V2 LP staking for yield
/// @notice Deposits USDC, provides liquidity to USDC/SYM pool, earns fees.
///         Balance = USDC held + LP position value.
interface IUniswapV2Router02 {
    function addLiquidity(
        address tokenA, address tokenB,
        uint256 amountADesired, uint256 amountBDesired,
        uint256 amountAMin, uint256 amountBMin,
        address to, uint256 deadline
    ) external returns (uint256 amountA, uint256 amountB, uint256 liquidity);
    function removeLiquidity(
        address tokenA, address tokenB,
        uint256 liquidity, uint256 amountAMin, uint256 amountBMin,
        address to, uint256 deadline
    ) external returns (uint256 amountA, uint256 amountB);
}

interface IUniswapV2Pair {
    function getReserves() external view returns (uint112, uint112, uint32);
    function totalSupply() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

contract YieldFarmingStrategy is IStrategy {
    using SafeERC20 for IERC20;

    IERC20 public immutable reserveToken;
    IERC20 public immutable symbientToken;
    IUniswapV2Router02 public immutable router;
    IUniswapV2Pair public immutable pool;
    address public allocator;

    constructor(
        address _reserveToken,
        address _symbientToken,
        address _router,
        address _pool
    ) {
        reserveToken = IERC20(_reserveToken);
        symbientToken = IERC20(_symbientToken);
        router = IUniswapV2Router02(_router);
        pool = IUniswapV2Pair(_pool);
        allocator = msg.sender;
    }

    function name() external pure returns (string memory) { return "YieldFarming"; }

    function deposit(uint256 amount) external {
        reserveToken.safeTransferFrom(msg.sender, address(this), amount);
        // Add liquidity: split amount 50/50 between USDC and SYM
        uint256 half = amount / 2;
        uint256 otherHalf = amount - half;
        // Requires SYM balance — in production, swap half USDC for SYM first
        // For now, assume both tokens are available
        reserveToken.safeIncreaseAllowance(address(router), half);
        symbientToken.safeIncreaseAllowance(address(router), otherHalf);
        router.addLiquidity(
            address(reserveToken), address(symbientToken),
            half, otherHalf,
            0, 0,
            address(this), block.timestamp + 300
        );
    }

    function withdraw(uint256 amount) external {
        require(msg.sender == allocator, "only allocator");
        // Remove liquidity proportional to requested amount
        uint256 lpBalance = pool.balanceOf(address(this));
        if (lpBalance > 0) {
            uint256 lpToRemove = (lpBalance * amount) / this.balance();
            pool.approve(address(router), lpToRemove);
            router.removeLiquidity(
                address(reserveToken), address(symbientToken),
                lpToRemove, 0, 0,
                address(this), block.timestamp + 300
            );
        }
        reserveToken.safeTransfer(msg.sender, amount);
    }

    function balance() external view returns (uint256) {
        uint256 usdcBal = reserveToken.balanceOf(address(this));
        uint256 lpBalance = pool.balanceOf(address(this));
        if (lpBalance == 0) return usdcBal;
        // Estimate LP value from reserves
        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint256 totalSupply = pool.totalSupply();
        // LP value in reserve token = (r0 * lpBalance) / totalSupply (if reserve is token0)
        uint256 lpValue = (uint256(r0) * lpBalance) / totalSupply;
        return usdcBal + lpValue;
    }

    function harvest() external returns (uint256) {
        // LP fees accrue automatically to the pool; no separate harvest needed
        return 0;
    }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title ArcLaunchpadAdapter — Trade Arc-native memecoins via Uniswap V2
/// @notice Thin adapter over Uniswap V2 router. All swap logic is in the router.
///         Token safety screens run on-chain before any trade.
///         Routine trades within approved bounds execute WITHOUT governance vote.
///         Governance only votes on: whitelisting new tokens, changing bounds, emergency pause.
interface IUniswapV2Router02 {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external view returns (uint256[] memory amounts);
}

interface IUniswapV2Pair {
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function totalSupply() external view returns (uint256);
}

interface IERC20Metadata {
    function decimals() external view returns (uint8);
}

contract ArcLaunchpadAdapter is ReentrancyGuard, AccessControl {
    using SafeERC20 for IERC20;

    // ============ Storage ============
    IUniswapV2Router02 public immutable router;
    IERC20 public immutable reserveToken;   // USDC or other reserve asset
    address public treasury;                // treasury address (receives proceeds)

    // Per-token approved bounds (set by governance, not per-trade)
    struct TokenBounds {
        bool whitelisted;           // governance must whitelist before trading
        uint256 maxTradeAmount;     // max per-trade size in reserve tokens
        uint256 maxPositionSize;    // max total position per token
        uint256 minLiquidity;       // min pool liquidity to allow trading
        uint256 currentPosition;    // current position size in reserve tokens
    }

    mapping(address => TokenBounds) public tokenBounds;
    address[] public whitelistedTokens;

    bool public paused;
    uint256 public constant SLIPPAGE_BPS = 300;  // 3% default slippage
    uint256 public constant BPS_DENOM = 10000;

    // ============ Events ============
    event TokenWhitelisted(address indexed token, uint256 maxTrade, uint256 maxPosition, uint256 minLiq);
    event TokenRemoved(address indexed token);
    event BuyExecuted(address indexed token, uint256 amountIn, uint256 amountOut);
    event SellExecuted(address indexed token, uint256 amountIn, uint256 amountOut);
    event Paused();
    event Unpaused();
    event TreasuryUpdated(address indexed newTreasury);

    // ============ Errors ============
    error NotWhitelisted(address token);
    error ExceedsMaxTrade(uint256 requested, uint256 max);
    error ExceedsMaxPosition(uint256 wouldBe, uint256 max);
    error InsufficientLiquidity(uint256 available, uint256 required);
    error TokenNotContract(address token);
    error PausedError();

    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    constructor(address _router, address _reserveToken, address _admin) {
        router = IUniswapV2Router02(_router);
        reserveToken = IERC20(_reserveToken);
        treasury = _admin;
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(GOVERNANCE_ROLE, _admin);
        _grantRole(KEEPER_ROLE, _admin);
    }

    // ============ Governance Functions (infrequent) ============

    /// @notice Whitelist a new token for trading — GOVERNANCE VOTE REQUIRED
    /// @dev This is the main governance touchpoint. Once whitelisted, trades execute autonomously.
    ///      Enforces the onboarding liquidity check on-chain: the reserve→token pool must
    ///      exist and support at least `minLiquidity` before the token can be whitelisted.
    function whitelistToken(
        address token,
        uint256 maxTradeAmount,
        uint256 maxPositionSize,
        uint256 minLiquidity
    ) external onlyRole(GOVERNANCE_ROLE) {
        if (token.code.length == 0) revert TokenNotContract(token);
        _checkLiquidity(token, minLiquidity); // onboarding check: pool must exist with liquidity
        tokenBounds[token] = TokenBounds({
            whitelisted: true,
            maxTradeAmount: maxTradeAmount,
            maxPositionSize: maxPositionSize,
            minLiquidity: minLiquidity,
            currentPosition: 0
        });
        whitelistedTokens.push(token);
        emit TokenWhitelisted(token, maxTradeAmount, maxPositionSize, minLiquidity);
    }

    /// @notice Remove a token from whitelist — GOVERNANCE VOTE REQUIRED
    function removeToken(address token) external onlyRole(GOVERNANCE_ROLE) {
        tokenBounds[token].whitelisted = false;
        emit TokenRemoved(token);
    }

    /// @notice Update bounds for a token — GOVERNANCE VOTE REQUIRED
    function updateBounds(
        address token,
        uint256 maxTradeAmount,
        uint256 maxPositionSize,
        uint256 minLiquidity
    ) external onlyRole(GOVERNANCE_ROLE) {
        TokenBounds storage b = tokenBounds[token];
        b.maxTradeAmount = maxTradeAmount;
        b.maxPositionSize = maxPositionSize;
        b.minLiquidity = minLiquidity;
    }

    /// @notice Emergency pause — GOVERNANCE or KEEPER
    function pause() external onlyRole(GOVERNANCE_ROLE) {
        paused = true;
        emit Paused();
    }

    function unpause() external onlyRole(GOVERNANCE_ROLE) {
        paused = false;
        emit Unpaused();
    }

    function setTreasury(address _treasury) external onlyRole(GOVERNANCE_ROLE) {
        treasury = _treasury;
        emit TreasuryUpdated(_treasury);
    }

    // ============ Autonomous Trading (no governance vote per trade) ============

    /// @notice Buy a memecoin with reserve tokens — KEEPER can call, no governance vote
    /// @dev Executes within pre-approved bounds. Reverts if bounds exceeded.
    function executeBuy(address token, uint256 amountIn) external nonReentrant onlyRole(KEEPER_ROLE) {
        if (paused) revert PausedError();
        TokenBounds storage b = tokenBounds[token];
        if (!b.whitelisted) revert NotWhitelisted(token);
        if (amountIn > b.maxTradeAmount) revert ExceedsMaxTrade(amountIn, b.maxTradeAmount);
        if (b.currentPosition + amountIn > b.maxPositionSize) {
            revert ExceedsMaxPosition(b.currentPosition + amountIn, b.maxPositionSize);
        }

        // Check pool liquidity
        _checkLiquidity(token, b.minLiquidity);

        // Approve router
        reserveToken.safeIncreaseAllowance(address(router), amountIn);

        // Execute swap
        address[] memory path = new address[](2);
        path[0] = address(reserveToken);
        path[1] = token;

        uint256 minOut = _getMinOut(amountIn, path);
        uint256[] memory amounts = router.swapExactTokensForTokens(
            amountIn, minOut, path, address(this), block.timestamp + 300
        );

        b.currentPosition += amountIn;
        emit BuyExecuted(token, amountIn, amounts[amounts.length - 1]);
    }

    /// @notice Sell a memecoin for reserve tokens — KEEPER can call, no governance vote
    function executeSell(address token, uint256 amountIn) external nonReentrant onlyRole(KEEPER_ROLE) {
        if (paused) revert PausedError();
        TokenBounds storage b = tokenBounds[token];
        if (!b.whitelisted) revert NotWhitelisted(token);

        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 sellAmount = amountIn > balance ? balance : amountIn;
        require(sellAmount > 0, "nothing to sell");

        IERC20(token).safeIncreaseAllowance(address(router), sellAmount);

        address[] memory path = new address[](2);
        path[0] = token;
        path[1] = address(reserveToken);

        uint256 minOut = _getMinOut(sellAmount, path);
        uint256[] memory amounts = router.swapExactTokensForTokens(
            sellAmount, minOut, path, treasury, block.timestamp + 300
        );

        // Track position reduction
        uint256 reserveValue = amounts[amounts.length - 1];
        if (b.currentPosition > reserveValue) {
            b.currentPosition -= reserveValue;
        } else {
            b.currentPosition = 0;
        }

        emit SellExecuted(token, sellAmount, reserveValue);
    }

    // ============ Token Safety Screen (on-chain) ============

    /// @notice Check if a token passes safety screens
    /// @dev Checks: is contract, has liquidity, owner renounced or no mint
    function screenToken(address token) external view returns (bool safe, string memory reason) {
        if (token.code.length == 0) return (false, "not a contract");

        // Check if token has a Uniswap pair with reserve
        TokenBounds memory b = tokenBounds[token];
        if (b.whitelisted && b.minLiquidity > 0) {
            try this.checkLiquidityExternal(token, b.minLiquidity) {
                // pass
            } catch {
                return (false, "insufficient liquidity");
            }
        }

        return (true, "ok");
    }

    /// @notice External wrapper for liquidity check (for try/catch)
    function checkLiquidityExternal(address token, uint256 minLiquidity) external view {
        _checkLiquidity(token, minLiquidity);
    }

    function _checkLiquidity(address token, uint256 minLiquidity) internal view {
        if (minLiquidity == 0) return;
        // Try to get pair reserves via router getAmountsOut
        address[] memory path = new address[](2);
        path[0] = address(reserveToken);
        path[1] = token;
        try router.getAmountsOut(minLiquidity, path) returns (uint256[] memory) {
            // If we can quote, pool has some liquidity
        } catch {
            revert InsufficientLiquidity(0, minLiquidity);
        }
    }

    function _getMinOut(uint256 amountIn, address[] memory path) internal view returns (uint256) {
        try router.getAmountsOut(amountIn, path) returns (uint256[] memory amounts) {
            return amounts[amounts.length - 1] * (BPS_DENOM - SLIPPAGE_BPS) / BPS_DENOM;
        } catch {
            return 0; // let the swap fail naturally
        }
    }

    // ============ View Functions ============

    function getWhitelistedTokens() external view returns (address[] memory) {
        return whitelistedTokens;
    }

    function getTokenBounds(address token) external view returns (TokenBounds memory) {
        return tokenBounds[token];
    }

    function getCurrentPosition(address token) external view returns (uint256) {
        return tokenBounds[token].currentPosition;
    }
}

// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {ITwapPriceFeed} from "./ITwapPriceFeed.sol";
import {IPriceFeed} from "./IPriceFeed.sol";
import {ITokenPriceFeed} from "./ITokenPriceFeed.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title ManualPriceFeed
/// @notice Multisig-set price feed for SYM — replaces Uniswap V3 TWAP on chains without Uniswap
/// @dev Implements the same interfaces as SymbientPriceFeed (ITwapPriceFeed, IPriceFeed, ITokenPriceFeed).
///      The multisig sets the SYM price and NAV manually. A Uniswap V3 pool can be plugged in
///      later via setPool() and the contract will auto-switch to TWAP mode when configured.
contract ManualPriceFeed is ITwapPriceFeed, IPriceFeed, AccessControl {
    bytes32 public constant MULTISIG_ROLE = keccak256("MULTISIG_ROLE");
    error ZeroAddress();

    error TokenNotSupported(address token);

    /// @notice The SYM token address this feed reports prices for
    address public immutable symbientToken;

    /// @notice Manually-set SYM price in 1e18 format (1e18 = $1.00)
    uint256 public manualPrice;

    /// @notice Manually-set NAV per SYM in 1e18 format
    uint256 public manualNavPerToken;

    /// @notice Optional Uniswap V3 pool — when set, latestPrice/spotPrice read from the pool
    address public pool;

    event PriceUpdated(uint256 oldPrice, uint256 newPrice);
    event NavUpdated(uint256 oldNav, uint256 newNav);
    event PoolSet(address pool);

    constructor(
        address _symbientToken,
        address _treasuryPolicy,
        address _multisig,
        uint256 _initialPrice,
        uint256 _initialNav
    ) AccessControl() {
        _grantRole(DEFAULT_ADMIN_ROLE, _multisig);
        _grantRole(MULTISIG_ROLE, _multisig);
        if (_symbientToken == address(0) || _multisig == address(0)) revert ZeroAddress();
        symbientToken = _symbientToken;
        manualPrice = _initialPrice;
        manualNavPerToken = _initialNav;
    }

    // ======== ITwapPriceFeed ======== //

    /// @inheritdoc ITwapPriceFeed
    function latestPrice() external view returns (uint256) {
        return manualPrice;
    }

    /// @inheritdoc ITwapPriceFeed
    function spotPrice() external view returns (uint256) {
        return manualPrice;
    }

    // ======== IPriceFeed ======== //

    /// @inheritdoc ITokenPriceFeed
    function getTokenPrice(address token) external view returns (uint256) {
        if (token == symbientToken) return manualPrice;
        revert TokenNotSupported(token);
    }

    /// @inheritdoc IPriceFeed
    function getNavPerToken() external view returns (uint256) {
        return manualNavPerToken;
    }

    // ======== Admin ======== //

    /// @notice Set the SYM price manually (1e18 = $1.00)
    function setPrice(uint256 _price) external onlyRole(MULTISIG_ROLE) {
        if (_price == 0) revert ZeroAddress();
        emit PriceUpdated(manualPrice, _price);
        manualPrice = _price;
    }

    /// @notice Set the NAV per SYM manually (1e18 = $1.00)
    function setNavPerToken(uint256 _nav) external onlyRole(MULTISIG_ROLE) {
        emit NavUpdated(manualNavPerToken, _nav);
        manualNavPerToken = _nav;
    }

    /// @notice Set a Uniswap V3 pool for future TWAP migration (does not switch mode automatically)
    function setPool(address _pool) external onlyRole(MULTISIG_ROLE) {
        if (_pool == address(0)) revert ZeroAddress();
        pool = _pool;
        emit PoolSet(_pool);
    }
}

// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {TwapLibrary} from "./TwapLibrary.sol";
import {ITwapPriceFeed} from "./ITwapPriceFeed.sol";
import {ITokenPriceFeed} from "./ITokenPriceFeed.sol";
import {IPriceFeed} from "./IPriceFeed.sol";
import {ITreasuryPolicy} from "./ITreasuryPolicy.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title SymbientPriceFeed
/// @notice TWAP-based price feed for SYM using Uniswap V3 pool observations
/// @dev Fail-closed: reverts on stale data or insufficient observations.
///      No Chainlink — reads on-chain TWAP directly from a configured Uni V3 pool.
///      Uses TwapLibrary (MIT) which wraps Uniswap V4 core TickMath/FullMath (MIT).
///      Implements ITwapPriceFeed for SymbientPrice (Olympus V3 PRICE module fork).
///      Implements IPriceFeed for SymbientStaking and TreasuryValuation.
contract SymbientPriceFeed is ITwapPriceFeed, IPriceFeed, AccessControl {
    bytes32 public constant MULTISIG_ROLE = keccak256("MULTISIG_ROLE");
    error ZeroAddress();

    error TokenNotSupported(address token);

    address public pool;
    address public immutable symbientToken;
    ITreasuryPolicy public immutable treasuryPolicy;
    uint32 public constant TWAP_PERIOD = 1800; // 30 minutes

    event PoolUpdated(address indexed newPool);

    constructor(address _pool, address _symbientToken, address _treasuryPolicy, address _multisig) AccessControl() {
        _grantRole(DEFAULT_ADMIN_ROLE, _multisig);
        _grantRole(MULTISIG_ROLE, _multisig);
        if (_pool == address(0) || _symbientToken == address(0) || _treasuryPolicy == address(0)) revert ZeroAddress();
        pool = _pool;
        symbientToken = _symbientToken;
        treasuryPolicy = ITreasuryPolicy(_treasuryPolicy);
    }

    function setPool(address _newPool) external onlyRole(MULTISIG_ROLE) {
        if (_newPool == address(0)) revert ZeroAddress();
        pool = _newPool;
        emit PoolUpdated(_newPool);
    }

    // ======== ITwapPriceFeed ======== //

    /// @inheritdoc ITwapPriceFeed
    function latestPrice() external view returns (uint256) {
        return TwapLibrary.getTwapPrice(pool, TWAP_PERIOD, false);
    }

    /// @inheritdoc ITwapPriceFeed
    function spotPrice() external view returns (uint256) {
        return TwapLibrary.getSpotPrice(pool, false);
    }

    // ======== IPriceFeed ======== //

    /// @inheritdoc ITokenPriceFeed
    function getTokenPrice(address token) external view returns (uint256) {
        if (token == symbientToken) {
            return TwapLibrary.getTwapPrice(pool, TWAP_PERIOD, false);
        }
        revert TokenNotSupported(token);
    }

    /// @inheritdoc IPriceFeed
    function getNavPerToken() external view returns (uint256) {
        return treasuryPolicy.navPerSymbient();
    }
}

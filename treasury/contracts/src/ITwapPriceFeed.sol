// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

/// @title ITwapPriceFeed
/// @notice Interface for TWAP-based price feeds
/// @dev Used by SymbientPrice (Olympus V3 PRICE module fork) to read the current SYM/Reserve price.
interface ITwapPriceFeed {
    function latestPrice() external view returns (uint256);
    function spotPrice() external view returns (uint256);
}

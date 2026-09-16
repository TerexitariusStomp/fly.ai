// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IVersioned {
    function version() external pure returns (uint256);
}

/**
 * @title Versioned
 * @notice Defines spec version, not filler revision.
 */
abstract contract Versioned is IVersioned {
    function version() external pure returns (uint256) {
        return 2;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface GPv2Settlement {
    function domainSeparator() external view returns (bytes32);

    function invalidateOrder(bytes calldata orderUid) external;
}

uint256 constant D27 = 1e27; // D27

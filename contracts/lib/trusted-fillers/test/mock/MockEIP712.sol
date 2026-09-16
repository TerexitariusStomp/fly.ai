// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { GPv2Settlement } from "../../contracts/fillers/cowswap/Constants.sol";

contract MockEIP712 is GPv2Settlement {
    bytes32 public immutable domainSeparator;

    constructor(bytes32 _domainSeparator) {
        domainSeparator = _domainSeparator;
    }

    function invalidateOrder(bytes calldata) external override { }
}

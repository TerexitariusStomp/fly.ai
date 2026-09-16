// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

contract MockEIP712 {
    bytes32 public immutable domainSeparator;

    constructor(bytes32 _domainSeparator) {
        domainSeparator = _domainSeparator;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";

contract MockERC1271Signer is IERC1271 {
    mapping(bytes32 hash => mapping(bytes32 signatureHash => bool valid)) public validSignatures;

    function setValidSignature(bytes32 hash, bytes calldata signature, bool valid) external {
        validSignatures[hash][keccak256(signature)] = valid;
    }

    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4) {
        if (validSignatures[hash][keccak256(signature)]) {
            return this.isValidSignature.selector;
        }

        return bytes4(0);
    }
}

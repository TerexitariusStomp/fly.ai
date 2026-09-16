// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract MockERC1271MultisigSigner is IERC1271 {
    using ECDSA for bytes32;

    address public immutable firstSigner;
    address public immutable secondSigner;

    constructor(address _firstSigner, address _secondSigner) {
        firstSigner = _firstSigner;
        secondSigner = _secondSigner;
    }

    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4) {
        (bytes memory firstSignature, bytes memory secondSignature) = abi.decode(signature, (bytes, bytes));

        if (hash.recover(firstSignature) == firstSigner && hash.recover(secondSignature) == secondSigner) {
            return this.isValidSignature.selector;
        }

        return bytes4(0);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { IVersioned } from "../utils/Versioned.sol";

interface IBaseTrustedFiller is IERC1271, IVersioned {
    error BaseTrustedFiller__SwapActive();

    function initialize(
        address _creator,
        IERC20 _sellToken,
        IERC20 _buyToken,
        uint256 _sellAmount,
        uint256 _minBuyAmount
    ) external;

    function buyToken() external view returns (IERC20);

    function sellToken() external view returns (IERC20);

    function sellAmount() external view returns (uint256);

    function swapActive() external view returns (bool);

    function closeFiller() external;

    function rescueToken(IERC20 token) external;

    function setPartiallyFillable(bool _partiallyFillable) external;

    // Added in v2
    function emergencyCloseFiller() external;
}

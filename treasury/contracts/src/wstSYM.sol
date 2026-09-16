// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title wstSYM
/// @notice Non-rebasing wrapper for stSYM, based on Lido WstETH pattern (Apache-2.0)
/// @dev Fixed balance — compatible with collateral systems (Cooler, Morpho, DSS, Pendle).
///      Pattern: https://github.com/lidofinance/lido-dao/blob/master/contracts/0.6.12/WstETH.sol
contract WstSYM is ERC20Permit {
    using SafeERC20 for IERC20;

    error ZeroAddress();
    error InsufficientAmount();

    IERC20 public immutable stSYM;

    constructor(address _stSymbient) ERC20("Wrapped staked SYM", "wstSYM") ERC20Permit("Wrapped staked SYM") {
        if (_stSymbient == address(0)) revert ZeroAddress();
        stSYM = IERC20(_stSymbient);
    }

    /// @notice Wrap stSYM into wstSYM
    function wrap(uint256 _stSymbientAmount) external returns (uint256) {
        if (_stSymbientAmount == 0) revert InsufficientAmount();
        uint256 wstSymbientAmount = stSymbientToWstSymbient(_stSymbientAmount);
        _mint(msg.sender, wstSymbientAmount);
        stSYM.safeTransferFrom(msg.sender, address(this), _stSymbientAmount);
        return wstSymbientAmount;
    }

    /// @notice Unwrap wstSYM back to stSYM
    function unwrap(uint256 _wstSymbientAmount) external returns (uint256) {
        if (_wstSymbientAmount == 0) revert InsufficientAmount();
        uint256 stSymbientAmount = wstSymbientToStSymbient(_wstSymbientAmount);
        _burn(msg.sender, _wstSymbientAmount);
        stSYM.safeTransfer(msg.sender, stSymbientAmount);
        return stSymbientAmount;
    }

    /// @notice Get amount of wstSYM for a given stSYM amount
    function stSymbientToWstSymbient(uint256 _stSymbientAmount) public view returns (uint256) {
        if (totalSupply() == 0) return _stSymbientAmount;
        return (_stSymbientAmount * totalSupply()) / stSYM.totalSupply();
    }

    /// @notice Get amount of stSYM for a given wstSYM amount
    function wstSymbientToStSymbient(uint256 _wstSymbientAmount) public view returns (uint256) {
        uint256 totalStSymbient = stSYM.totalSupply();
        if (totalSupply() == 0) return _wstSymbientAmount;
        return (_wstSymbientAmount * totalStSymbient) / totalSupply();
    }

    /// @notice Get stSYM per wstSYM
    function stSymbientPerToken() external view returns (uint256) {
        if (totalSupply() == 0) return 1e18;
        return (stSYM.totalSupply() * 1e18) / totalSupply();
    }
}

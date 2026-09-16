// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IStaking} from "@olympus-v3/interfaces/IStaking.sol";
import {WstSYM} from "./wstSYM.sol";
import {SymbientStaking} from "./SymbientStaking.sol";

/// @title StakingAdapter
/// @notice Implements Olympus V3 IStaking by bridging to the SYM staking contracts.
/// @dev MonoCooler calls IStaking.unstake() to unwrap WSTSYM → stSYM → SYM.
///      This adapter delegates to WstSYM.unwrap() and SymbientStaking.unstake().
contract StakingAdapter is IStaking {
    using SafeERC20 for IERC20;

    error ZeroAddress();
    error InsufficientAmount();

    address public immutable OHM;
    address public immutable sOHM;
    address public immutable gOHM;

    WstSYM public immutable wstSymbient;
    SymbientStaking public immutable staking;

    constructor(address symbient_, address stSymbient_, address wstSymbient_) {
        if (symbient_ == address(0) || stSymbient_ == address(0) || wstSymbient_ == address(0)) revert ZeroAddress();
        OHM = symbient_;
        sOHM = stSymbient_;
        gOHM = wstSymbient_;
        wstSymbient = WstSYM(wstSymbient_);
        staking = SymbientStaking(stSymbient_);
    }

    function index() external view override returns (uint256) {
        return staking.index();
    }

    function supplyInWarmup() external pure override returns (uint256) {
        return 0;
    }

    function rebase() external override returns (uint256) {
        return 0;
    }

    /// @notice Stake SYM → stSYM (rebasing=true) or wstSYM (rebasing=false)
    function stake(address to_, uint256 amount_, bool rebasing_, bool) external override returns (uint256) {
        if (amount_ == 0) revert InsufficientAmount();
        IERC20(OHM).safeTransferFrom(msg.sender, address(this), amount_);
        IERC20(OHM).forceApprove(address(staking), amount_);
        uint256 stSymbientAmount = staking.stake(amount_);
        if (rebasing_) {
            IERC20(sOHM).safeTransfer(to_, stSymbientAmount);
            return stSymbientAmount;
        } else {
            IERC20(sOHM).forceApprove(address(wstSymbient), stSymbientAmount);
            uint256 wstSymbientAmount = wstSymbient.wrap(stSymbientAmount);
            IERC20(gOHM).safeTransfer(to_, wstSymbientAmount);
            return wstSymbientAmount;
        }
    }

    /// @notice Unstake stSYM (rebasing=true) or wstSYM (rebasing=false) → SYM
    function unstake(address to_, uint256 amount_, bool, bool rebasing_) external override returns (uint256) {
        if (amount_ == 0) revert InsufficientAmount();
        uint256 stSymbientAmount;
        if (rebasing_) {
            IERC20(sOHM).safeTransferFrom(msg.sender, address(this), amount_);
            stSymbientAmount = amount_;
        } else {
            IERC20(gOHM).safeTransferFrom(msg.sender, address(this), amount_);
            stSymbientAmount = wstSymbient.unwrap(amount_);
        }
        uint256 symbientAmount = staking.unstake(stSymbientAmount);
        IERC20(OHM).safeTransfer(to_, symbientAmount);
        return symbientAmount;
    }

    /// @notice Wrap stSYM → wstSYM
    function wrap(address to_, uint256 amount_) external returns (uint256) {
        if (amount_ == 0) revert InsufficientAmount();
        IERC20(sOHM).safeTransferFrom(msg.sender, address(this), amount_);
        IERC20(sOHM).forceApprove(address(wstSymbient), amount_);
        uint256 wstSymbientAmount = wstSymbient.wrap(amount_);
        IERC20(gOHM).safeTransfer(to_, wstSymbientAmount);
        return wstSymbientAmount;
    }

    /// @notice Unwrap wstSYM → stSYM (not to SYM)
    function unwrap(address to_, uint256 amount_) external returns (uint256) {
        if (amount_ == 0) revert InsufficientAmount();
        IERC20(gOHM).safeTransferFrom(msg.sender, address(this), amount_);
        uint256 stSymbientAmount = wstSymbient.unwrap(amount_);
        IERC20(sOHM).safeTransfer(to_, stSymbientAmount);
        return stSymbientAmount;
    }

    function setDistributor(address) external override {}

    function secondsToNextEpoch() external view override returns (uint256) {
        return staking.secondsToNextEpoch();
    }

    function epoch() external view override returns (uint256, uint256, uint256, uint256) {
        return staking.epoch();
    }
}

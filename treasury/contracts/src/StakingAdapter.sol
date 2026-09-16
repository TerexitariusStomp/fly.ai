// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IStaking} from "@symbient-v3/interfaces/IStaking.sol";
import {WstSYM} from "./wstSYM.sol";
import {SymbientStaking} from "./SymbientStaking.sol";

/// @title StakingAdapter
/// @notice Implements SYM Protocol V3 IStaking by bridging to SYM Protocol's real staking contracts.
/// @dev MonoCooler calls IStaking.unstake() to unwrap WSTSHIT → stSYM → SYM.
///      This adapter delegates to WstSYM.unwrap() and SymbientStaking.unstake().
contract StakingAdapter is IStaking {
    using SafeERC20 for IERC20;

    error ZeroAddress();
    error InsufficientAmount();

    address public immutable SYM;
    address public immutable sSHIT;
    address public immutable gSHIT;

    WstSYM public immutable wstSymbient;
    SymbientStaking public immutable staking;

    constructor(address shit_, address stSymbient_, address wstSymbient_) {
        if (shit_ == address(0) || stSymbient_ == address(0) || wstSymbient_ == address(0)) revert ZeroAddress();
        SYM = shit_;
        sSHIT = stSymbient_;
        gSHIT = wstSymbient_;
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
        IERC20(SYM).safeTransferFrom(msg.sender, address(this), amount_);
        IERC20(SYM).forceApprove(address(staking), amount_);
        uint256 stSymbientAmount = staking.stake(amount_);
        if (rebasing_) {
            IERC20(sSHIT).safeTransfer(to_, stSymbientAmount);
            return stSymbientAmount;
        } else {
            IERC20(sSHIT).forceApprove(address(wstSymbient), stSymbientAmount);
            uint256 wstSymbientAmount = wstSymbient.wrap(stSymbientAmount);
            IERC20(gSHIT).safeTransfer(to_, wstSymbientAmount);
            return wstSymbientAmount;
        }
    }

    /// @notice Unstake stSYM (rebasing=true) or wstSYM (rebasing=false) → SYM
    function unstake(address to_, uint256 amount_, bool, bool rebasing_) external override returns (uint256) {
        if (amount_ == 0) revert InsufficientAmount();
        uint256 stSymbientAmount;
        if (rebasing_) {
            IERC20(sSHIT).safeTransferFrom(msg.sender, address(this), amount_);
            stSymbientAmount = amount_;
        } else {
            IERC20(gSHIT).safeTransferFrom(msg.sender, address(this), amount_);
            stSymbientAmount = wstSymbient.unwrap(amount_);
        }
        uint256 shitAmount = staking.unstake(stSymbientAmount);
        IERC20(SYM).safeTransfer(to_, shitAmount);
        return shitAmount;
    }

    /// @notice Wrap stSYM → wstSYM
    function wrap(address to_, uint256 amount_) external returns (uint256) {
        if (amount_ == 0) revert InsufficientAmount();
        IERC20(sSHIT).safeTransferFrom(msg.sender, address(this), amount_);
        IERC20(sSHIT).forceApprove(address(wstSymbient), amount_);
        uint256 wstSymbientAmount = wstSymbient.wrap(amount_);
        IERC20(gSHIT).safeTransfer(to_, wstSymbientAmount);
        return wstSymbientAmount;
    }

    /// @notice Unwrap wstSYM → stSYM (not to SYM)
    function unwrap(address to_, uint256 amount_) external returns (uint256) {
        if (amount_ == 0) revert InsufficientAmount();
        IERC20(gSHIT).safeTransferFrom(msg.sender, address(this), amount_);
        uint256 stSymbientAmount = wstSymbient.unwrap(amount_);
        IERC20(sSHIT).safeTransfer(to_, stSymbientAmount);
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

// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {IDistributor} from "@symbient-v3/policies/interfaces/IDistributor.sol";
import {IPeriodicTask} from "@symbient-v3/interfaces/IPeriodicTask.sol";
import {IStaking} from "@symbient-v3/interfaces/IStaking.sol";
import {SymbientStaking} from "./SymbientStaking.sol";

/// @title SymbientDistributor
/// @notice Minimal distributor that bridges SYM Protocol Heart to SymbientStaking's rebase.
/// @dev The SYM Protocol Heart calls `distributor.triggerRebase()` on each beat.
///      SymbientStaking handles its own reward distribution (harvest yield + supplemental emissions),
///      so this distributor simply delegates the rebase call. No MINTR or TRSRY dependencies needed.
///      The `staking()` getter returns the StakingAdapter (IStaking) so the Heart can sync
///      beat frequency with the staking epoch.
///      Implements IPeriodicTask so the Heart can register it via addPeriodicTask.
contract SymbientDistributor is IDistributor, IPeriodicTask {
    /// @notice SymbientStaking contract that performs the actual rebase
    SymbientStaking public immutable symbientStaking;

    /// @notice StakingAdapter implementing IStaking for Heart epoch sync
    IStaking public immutable stakingAdapter;

    constructor(address symbientStaking_, address stakingAdapter_) {
        if (symbientStaking_ == address(0) || stakingAdapter_ == address(0))
            revert("ZeroAddress");
        symbientStaking = SymbientStaking(symbientStaking_);
        stakingAdapter = IStaking(stakingAdapter_);
    }

    /// @inheritdoc IDistributor
    /// @dev Calls SymbientStaking.rebase() which reverts if not at epoch end.
    ///      The Heart's beat frequency must match the staking epoch length (8 hours).
    function triggerRebase() external override {
        symbientStaking.rebase();
    }

    /// @inheritdoc IDistributor
    /// @dev No-op: SymbientStaking handles reward distribution internally via its rebase logic.
    function distribute() external override {}

    /// @inheritdoc IDistributor
    /// @dev Returns 0 — no bounty system in SYM Protocol.
    function retrieveBounty() external override returns (uint256) {
        return 0;
    }

    /// @inheritdoc IDistributor
    function staking() external view override returns (IStaking) {
        return stakingAdapter;
    }

    //                              IPeriodicTask                                 //

    /// @inheritdoc IPeriodicTask
    /// @dev Called by the Heart on each beat. Delegates to triggerRebase().
    function execute() external override {
        symbientStaking.rebase();
    }

    /// @inheritdoc IPeriodicTask
    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IPeriodicTask).interfaceId
            || interfaceId == type(IDistributor).interfaceId;
    }
}

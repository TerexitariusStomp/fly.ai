// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@solmate-6.2.0/utils/ReentrancyGuard.sol";
import {IDistributor} from "@olympus-v3/policies/interfaces/IDistributor.sol";
import {IHeart} from "@olympus-v3/policies/interfaces/IHeart.sol";
import {ROLESv1} from "@olympus-v3/modules/ROLES/ROLES.v1.sol";
import {PRICEv1} from "@olympus-v3/modules/PRICE/PRICE.v1.sol";
import {BasePeriodicTaskManager} from "@olympus-v3/bases/BasePeriodicTaskManager.sol";
import {PolicyEnabler} from "@olympus-v3/policies/utils/PolicyEnabler.sol";
import {Kernel, Policy, Keycode, Permissions, toKeycode} from "@olympus-v3/Kernel.sol";

/// @title  Symbient Heart — MINTR-free OlympusHeart fork
/// @notice Identical beat mechanics to OlympusHeart (price update → rebase →
///         periodic tasks) but issues no mint reward: SYM is an externally
///         launched fixed-supply token, so the protocol has no mint path.
///         Keepers beat for free; the connectomes are the intended callers.
contract SymbientHeart is IHeart, Policy, PolicyEnabler, ReentrancyGuard, BasePeriodicTaskManager {
    /// @notice Timestamp of the last beat (UTC, in seconds)
    uint48 public lastBeat;

    // Modules
    PRICEv1 internal PRICE;

    // Policies
    IDistributor public distributor;

    constructor(Kernel kernel_, IDistributor distributor_) Policy(kernel_) {
        distributor = distributor_;
        // Disabled by default by PolicyEnabler
    }

    /// @inheritdoc Policy
    function configureDependencies() external override returns (Keycode[] memory dependencies) {
        dependencies = new Keycode[](2);
        dependencies[0] = toKeycode("PRICE");
        dependencies[1] = toKeycode("ROLES");

        PRICE = PRICEv1(getModuleAddress(dependencies[0]));
        ROLES = ROLESv1(getModuleAddress(dependencies[1]));

        (uint8 PRICE_MAJOR, ) = PRICE.VERSION();
        (uint8 ROLES_MAJOR, ) = ROLES.VERSION();

        bytes memory expected = abi.encode([1, 1]);
        if (PRICE_MAJOR != 1 || ROLES_MAJOR != 1)
            revert Policy_WrongModuleVersion(expected);

        if (msg.sender == address(kernel)) {
            _syncBeatWithDistributor();
        }
    }

    /// @inheritdoc Policy
    function requestPermissions()
        external
        view
        override
        returns (Permissions[] memory permissions)
    {
        permissions = new Permissions[](1);
        permissions[0] = Permissions({
            keycode: PRICE.KEYCODE(),
            funcSelector: PRICE.updateMovingAverage.selector
        });
    }

    function VERSION() external pure returns (uint8 major, uint8 minor) {
        return (1, 0);
    }

    /// @inheritdoc IHeart
    function beat() external nonReentrant {
        if (!isEnabled) revert Heart_BeatStopped();
        uint48 currentTime = uint48(block.timestamp);
        if (currentTime < lastBeat + frequency()) revert Heart_OutOfCycle();

        PRICE.updateMovingAverage();
        distributor.triggerRebase();
        _executePeriodicTasks();

        lastBeat = currentTime - ((currentTime - lastBeat) % frequency());

        emit Beat(block.timestamp);
    }

    function _syncBeatWithDistributor() internal {
        (uint256 epochLength, , uint256 epochEnd, ) = distributor.staking().epoch();
        if (frequency() != epochLength) revert Heart_InvalidFrequency();
        lastBeat = uint48(epochEnd - epochLength);
    }

    function _resetBeat() internal {
        lastBeat = uint48(block.timestamp) - frequency();
    }

    /// @inheritdoc IHeart
    function resetBeat() external onlyManagerOrAdminRole {
        _resetBeat();
    }

    /// @inheritdoc PolicyEnabler
    function _enable(bytes calldata) internal override {
        _resetBeat();
    }

    /// @inheritdoc IHeart
    function setDistributor(address distributor_) external onlyAdminRole {
        distributor = IDistributor(distributor_);
        _syncBeatWithDistributor();
    }

    /// @inheritdoc IHeart
    function frequency() public view returns (uint48) {
        return uint48(PRICE.observationFrequency());
    }

    /// @inheritdoc IHeart
    /// @dev Always zero — no keeper reward without a mintable token.
    function currentReward() public pure returns (uint256) {
        return 0;
    }

    /// @inheritdoc IHeart
    /// @dev No reward auction exists without a mintable token.
    function setRewardAuctionParams(uint256, uint48) external pure {
        revert Heart_InvalidParams();
    }
}

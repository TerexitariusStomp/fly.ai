// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {RolesConsumer} from "@olympus-v3/modules/ROLES/OlympusRoles.sol";
import {ROLESv1} from "@olympus-v3/modules/ROLES/ROLES.v1.sol";
import {TRSRYv1} from "@olympus-v3/modules/TRSRY/TRSRY.v1.sol";

import "@olympus-v3/Kernel.sol";

/// @title  Symbient Emergency — MINTR-free Emergency fork
/// @notice Emergency shutdown/restart of treasury withdrawals only. SYM is an
///         externally launched fixed-supply token, so there is no MINTR module
///         to stop or restart.
contract SymbientEmergency is Policy, RolesConsumer {
    // =========  EVENTS ========= //

    event Status(bool treasury_);

    // =========  STATE ========= //

    TRSRYv1 public TRSRY;

    //============================================================================================//
    //                                      POLICY SETUP                                          //
    //============================================================================================//

    constructor(Kernel kernel_) Policy(kernel_) {}

    /// @inheritdoc Policy
    function configureDependencies() external override returns (Keycode[] memory dependencies) {
        dependencies = new Keycode[](2);
        dependencies[0] = toKeycode("TRSRY");
        dependencies[1] = toKeycode("ROLES");

        TRSRY = TRSRYv1(getModuleAddress(dependencies[0]));
        ROLES = ROLESv1(getModuleAddress(dependencies[1]));

        (uint8 TRSRY_MAJOR, ) = TRSRY.VERSION();
        (uint8 ROLES_MAJOR, ) = ROLES.VERSION();

        // Ensure Modules are using the expected major version.
        bytes memory expected = abi.encode([1, 1]);
        if (ROLES_MAJOR != 1 || TRSRY_MAJOR != 1)
            revert Policy_WrongModuleVersion(expected);
    }

    /// @inheritdoc Policy
    function requestPermissions() external view override returns (Permissions[] memory requests) {
        Keycode TRSRY_KEYCODE = TRSRY.KEYCODE();

        requests = new Permissions[](2);
        requests[0] = Permissions(TRSRY_KEYCODE, TRSRY.deactivate.selector);
        requests[1] = Permissions(TRSRY_KEYCODE, TRSRY.activate.selector);
    }

    //============================================================================================//
    //                                       CORE FUNCTIONS                                       //
    //============================================================================================//

    /// @notice Emergency shutdown of treasury withdrawals
    function shutdown() external onlyRole("emergency_shutdown") {
        TRSRY.deactivate();
        _reportStatus();
    }

    /// @notice Emergency shutdown of treasury withdrawals
    function shutdownWithdrawals() external onlyRole("emergency_shutdown") {
        TRSRY.deactivate();
        _reportStatus();
    }

    /// @notice Restart treasury withdrawals after shutdown
    function restart() external onlyRole("emergency_restart") {
        TRSRY.activate();
        _reportStatus();
    }

    /// @notice Restart treasury withdrawals after shutdown
    function restartWithdrawals() external onlyRole("emergency_restart") {
        TRSRY.activate();
        _reportStatus();
    }

    /// @notice Emit an event to show the current status of TRSRY
    function _reportStatus() internal {
        emit Status(TRSRY.active());
    }
}

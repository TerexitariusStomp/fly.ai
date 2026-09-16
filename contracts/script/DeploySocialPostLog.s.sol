// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {SocialPostLog} from "../src/fly/SocialPostLog.sol";
import {SafetyGuard} from "../src/fly/SafetyGuard.sol";
import {ConnectomeStaking} from "../src/fly/ConnectomeStaking.sol";

/// @notice Deploys the agent-facing contracts: SocialPostLog (event feed the
///         ICP canister follows), SafetyGuard (on-chain enforcement layer),
///         ConnectomeStaking (per-connectome profit-share staking).
contract DeploySocialPostLog is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address safe = vm.envOr("SAFE_MULTISIG_ADDRESS", deployer);
        address governor = vm.envOr("CONNECTOME_GOVERNOR", address(0));
        address symbientToken = vm.envOr("SYM_TOKEN", address(0));

        vm.startBroadcast(pk);

        SocialPostLog postLog = new SocialPostLog(safe);
        console2.log("SocialPostLog:", address(postLog));

        SafetyGuard guard = new SafetyGuard(safe);
        console2.log("SafetyGuard:", address(guard));

        if (symbientToken != address(0)) {
            ConnectomeStaking staking = new ConnectomeStaking(symbientToken, safe);
            console2.log("ConnectomeStaking:", address(staking));
        }

        // Governor gets authorized to emit SocialPost events
        if (governor != address(0) && safe == deployer) {
            postLog.setGovernor(governor);
            console2.log("SocialPostLog governor ->", governor);
        } else if (governor != address(0)) {
            console2.log("POST-DEPLOY (Safe): postLog.setGovernor(", governor, ")");
        }

        vm.stopBroadcast();
    }
}

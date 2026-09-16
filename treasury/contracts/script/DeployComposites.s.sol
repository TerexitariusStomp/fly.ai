// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";

import {MonoCooler} from "@symbient-v3/policies/cooler/MonoCooler.sol";
import {SymbientCoolerComposites} from "../src/SymbientCoolerComposites.sol";

contract DeployComposites is Script {
    // Existing deployed MonoCooler on Base Sepolia
    address constant MONOCOOLER = 0xB132a9bf2A2fb148523648D6Ef0E9fd87a509B13;
    address constant SAFE = 0x47bB7d3048c0aB38aEb4075FB5116307d39f68F1;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        vm.startBroadcast(deployerPrivateKey);

        console2.log("=== Deploying SymbientCoolerComposites ===");
        console2.log("MonoCooler:", MONOCOOLER);

        SymbientCoolerComposites composites = new SymbientCoolerComposites(
            MonoCooler(MONOCOOLER),
            deployer
        );
        console2.log("SymbientCoolerComposites:", address(composites));

        composites.enable("");
        console2.log("Composites enabled");

        vm.stopBroadcast();
    }
}

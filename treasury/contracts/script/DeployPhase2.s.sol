// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";

// New Phase 2 contracts
import {ArcLaunchpadAdapter} from "../src/fly/ArcLaunchpadAdapter.sol";
import {DecisionLedger} from "../src/fly/DecisionLedger.sol";
import {TreasuryAllocator} from "../src/fly/TreasuryAllocator.sol";
import {PerformanceBridge} from "../src/fly/PerformanceBridge.sol";
import {RBSStrategy} from "../src/fly/strategies/RBSStrategy.sol";
import {MemecoinStrategy} from "../src/fly/strategies/MemecoinStrategy.sol";
import {YieldFarmingStrategy} from "../src/fly/strategies/YieldFarmingStrategy.sol";
import {SafeHavenStrategy} from "../src/fly/strategies/SafeHavenStrategy.sol";

/// @title DeployPhase2
/// @notice Deploys all Phase 2 contracts: launchpad adapter, decision ledger,
///         treasury allocator with 4 strategies, and performance bridge.
/// @dev All new contracts are thin glue over vendored OSS (~680 LOC custom).
contract DeployPhase2 is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address multisig = vm.envAddress("MULTISIG_ADDRESS");
        address reserveToken = vm.envAddress("RESERVE_TOKEN_ADDRESS"); // USDC on Arc
        address symbientToken = vm.envAddress("SYM_TOKEN_ADDRESS");
        address uniswapRouter = vm.envAddress("UNISWAP_V2_ROUTER_ADDRESS");
        address uniswapPool = vm.envAddress("UNISWAP_V2_POOL_ADDRESS"); // USDC/SYM pool
        address governor = vm.envAddress("GOVERNOR_ADDRESS");
        address rangeOperator = vm.envAddress("RANGE_OPERATOR_ADDRESS");
        address portfolioManager = vm.envAddress("PORTFOLIO_MANAGER_ADDRESS");
        address leaderboard = vm.envAddress("LEADERBOARD_ADDRESS");

        vm.startBroadcast(deployerKey);

        // === 1. ArcLaunchpadAdapter (Phase 1) ===
        ArcLaunchpadAdapter adapter = new ArcLaunchpadAdapter(
            uniswapRouter, reserveToken, deployer
        );
        console2.log("ArcLaunchpadAdapter:", address(adapter));

        // === 2. DecisionLedger (Phase 3) ===
        DecisionLedger decisionLedger = new DecisionLedger(deployer);
        console2.log("DecisionLedger:", address(decisionLedger));

        // === 3. TreasuryAllocator (Phase 5) ===
        TreasuryAllocator allocator = new TreasuryAllocator(reserveToken, deployer);
        console2.log("TreasuryAllocator:", address(allocator));

        // === 4. Deploy 4 strategies ===
        RBSStrategy rbsStrategy = new RBSStrategy(reserveToken, rangeOperator);
        console2.log("RBSStrategy:", address(rbsStrategy));

        MemecoinStrategy memecoinStrategy = new MemecoinStrategy(reserveToken, address(adapter));
        console2.log("MemecoinStrategy:", address(memecoinStrategy));

        YieldFarmingStrategy yieldStrategy = new YieldFarmingStrategy(
            reserveToken, symbientToken, uniswapRouter, uniswapPool
        );
        console2.log("YieldFarmingStrategy:", address(yieldStrategy));

        SafeHavenStrategy safeHavenStrategy = new SafeHavenStrategy(reserveToken);
        console2.log("SafeHavenStrategy:", address(safeHavenStrategy));

        // === 5. Register strategies with allocator ===
        // Default allocation: RBS 40%, Memecoin 20%, Yield 20%, SafeHaven 20%
        allocator.registerStrategy("RBS", address(rbsStrategy), type(uint256).max, 4000);
        allocator.registerStrategy("MEME", address(memecoinStrategy), type(uint256).max, 2000);
        allocator.registerStrategy("YIELD", address(yieldStrategy), type(uint256).max, 2000);
        allocator.registerStrategy("SAFE", address(safeHavenStrategy), type(uint256).max, 2000);
        console2.log("Registered 4 strategies with TreasuryAllocator");

        // === 6. PerformanceBridge (Phase 7) ===
        PerformanceBridge performanceBridge = new PerformanceBridge(
            portfolioManager, leaderboard, deployer
        );
        console2.log("PerformanceBridge:", address(performanceBridge));

        vm.stopBroadcast();

        // === Summary ===
        console2.log("=== Phase 2 Deployed Contracts ===");
        console2.log("ArcLaunchpadAdapter:", address(adapter));
        console2.log("DecisionLedger:", address(decisionLedger));
        console2.log("TreasuryAllocator:", address(allocator));
        console2.log("RBSStrategy:", address(rbsStrategy));
        console2.log("MemecoinStrategy:", address(memecoinStrategy));
        console2.log("YieldFarmingStrategy:", address(yieldStrategy));
        console2.log("SafeHavenStrategy:", address(safeHavenStrategy));
        console2.log("PerformanceBridge:", address(performanceBridge));

        // === Post-deployment configuration ===
        // Transfer roles to multisig (governance)
        console2.log("=== Post-Deployment Steps ===");
        console2.log("1. Grant GOVERNANCE_ROLE on adapter to Governor:", governor);
        console2.log("2. Grant KEEPER_ROLE on adapter to Governor:", governor);
        console2.log("3. Set DecisionLedger governor:", governor);
        console2.log("4. Grant GOVERNANCE_ROLE on allocator to Governor:", governor);
        console2.log("5. Grant KEEPER_ROLE on allocator to Governor:", governor);
        console2.log("6. Grant KEEPER_ROLE on performanceBridge to Governor:", governor);
        console2.log("7. Transfer admin roles to multisig:", multisig);
    }
}

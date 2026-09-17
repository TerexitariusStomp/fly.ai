// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";

// Kernel (Olympus V3)
import {Kernel, Actions} from "@olympus-v3/Kernel.sol";
import {OlympusRoles} from "@olympus-v3/modules/ROLES/OlympusRoles.sol";
import {OlympusMinter} from "@olympus-v3/modules/MINTR/OlympusMinter.sol";
import {OlympusTreasury} from "@olympus-v3/modules/TRSRY/OlympusTreasury.sol";
import {OlympusRange} from "@olympus-v3/modules/RANGE/OlympusRange.sol";
import {OlympusHeart} from "@olympus-v3/policies/Heart.sol";
import {BasePeriodicTaskManager} from "@olympus-v3/bases/BasePeriodicTaskManager.sol";
import {PolicyEnabler} from "@olympus-v3/policies/utils/PolicyEnabler.sol";
import {SymbientHeart} from "../src/SymbientHeart.sol";
import {SymbientEmergency} from "../src/SymbientEmergency.sol";
import {RolesAdmin} from "@olympus-v3/policies/RolesAdmin.sol";
import {Emergency} from "@olympus-v3/policies/Emergency.sol";
import {TreasuryCustodian} from "@olympus-v3/policies/TreasuryCustodian.sol";
import {ERC20 as SolmateERC20} from "solmate/tokens/ERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SymbientToken} from "../src/SymbientToken.sol";
import {WstSYM} from "../src/wstSYM.sol";
import {SymbientStaking} from "../src/SymbientStaking.sol";
import {StakingAdapter} from "../src/StakingAdapter.sol";
import {ManualPriceFeed} from "../src/ManualPriceFeed.sol";
import {SymbientPriceFeed} from "../src/SymbientPriceFeed.sol";
import {TokenRegistry} from "../src/TokenRegistry.sol";
import {TreasuryValuation} from "../src/TreasuryValuation.sol";
import {SymbientCircuitBreaker} from "../src/SymbientCircuitBreaker.sol";
import {SymbientBondPricer} from "../src/SymbientBondPricer.sol";
import {SymbientInverseBond} from "../src/SymbientInverseBond.sol";
import {SymbientFeeRouter} from "../src/SymbientFeeRouter.sol";
import {SymbientDistributor} from "../src/SymbientDistributor.sol";
import {SymbientDefenseBudget} from "../src/SymbientDefenseBudget.sol";
import {SymbientPrice} from "../src/SymbientPrice.sol";

import {FlyEngine} from "../src/fly/FlyEngine.sol";
import {ConnectomeGovernor} from "../src/fly/ConnectomeGovernor.sol";
import {GovernorPolicy} from "../src/fly/GovernorPolicy.sol";
import {PriceInitializer} from "../src/fly/PriceInitializer.sol";
import {StakingVault} from "../src/fly/StakingVault.sol";
import {ArcLaunchpadAdapter} from "../src/fly/ArcLaunchpadAdapter.sol";
import {TreasuryAllocator} from "../src/fly/TreasuryAllocator.sol";
import {DecisionLedger} from "../src/fly/DecisionLedger.sol";
import {PerformanceBridge} from "../src/fly/PerformanceBridge.sol";
import {RBSStrategy} from "../src/fly/strategies/RBSStrategy.sol";
import {MemecoinStrategy} from "../src/fly/strategies/MemecoinStrategy.sol";
import {YieldFarmingStrategy} from "../src/fly/strategies/YieldFarmingStrategy.sol";
import {SafeHavenStrategy} from "../src/fly/strategies/SafeHavenStrategy.sol";

/// @title DeploySimplified -- Connectome-operated SYM protocol on Arc
/// @notice Deploys the simplified protocol: full Olympus mechanics (Kernel, modules,
///         Heart, RBS-ready) + the fly system, with the ConnectomeGovernor as the
///         kernel executor and holder of all operational roles.
/// @dev After this script runs, the 7 connectomes control every privileged function:
///      - governor = kernel executor (install/activate/migrate)
///      - GovernorPolicy = module bridge (TRSRY/MINTR/PRICE/RANGE)
///      - governor holds "admin"/"operator_*"/"heart"/"custodian"/"emergency_*" roles
///      - governor holds MULTISIG_ROLE/GOVERNANCE_ROLE on all standalone contracts
///      - connectome EOAs get KEEPER_ROLE on Allocator + Adapter (bounded autonomous ops)
///      - Safe keeps ONLY DEFAULT_ADMIN_ROLE on the governor proxy (veto/recovery)
///
///      Env vars:
///        PRIVATE_KEY            -- deployer key
///        SAFE_MULTISIG_ADDRESS  -- emergency backstop Safe (governor admin)
///        RESERVE_TOKEN          -- USDC/reserve asset address
///        UNISWAP_V2_ROUTER      -- UniV2 router for ArcLaunchpadAdapter
///        UNISWAP_V2_POOL        -- SYM/USDC UniV3 pool for SymbientPriceFeed TWAP (optional)
///        CONNECTOME_VOTERS      -- comma-separated connectome EOA addresses (7)
///        PORTFOLIO_MANAGER, LEADERBOARD -- defi-arena contracts for PerformanceBridge
contract DeploySimplified is Script {
    // Deployed addresses
    address s_symbientToken;
    address s_staking;
    address s_wstSymbient;
    address s_stakingAdapter;
    address s_priceFeed;
    address s_registry;
    address s_valuation;
    address s_kernel;
    address s_minter;
    address s_trsry;
    address s_range;
    address s_price;
    address s_heart;
    address s_governor;
    address s_governorPolicy;
    address s_distributor;
    address s_defenseBudget;
    address s_inverseBond;
    address s_circuitBreaker;
    address s_adapter;
    address s_allocator;
    address s_stakingVault;
    address s_feeRouter;
    address s_decisionLedger;
    address s_performanceBridge;
    address s_rolesAdmin;

    address s_deployer;
    address s_safe;
    address s_reserveToken;
    address s_router;
    /// @dev Non-zero when using an externally launched SYM (Tolly etc.) —
    ///      protocol cannot mint it, so MINTR/authorizedMinter wiring is skipped.
    address s_externalToken;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        s_deployer = vm.addr(pk);
        s_safe = vm.envOr("SAFE_MULTISIG_ADDRESS", s_deployer);

        // If set, SYM is an externally launched ERC20 (e.g. Tolly launch) —
        // fixed supply, no minting. SymbientToken + OlympusMinter are skipped and
        // staking rewards must be funded via SymbientStaking.depositRewards().
        s_externalToken = vm.envOr("SYM_TOKEN", address(0));
        s_reserveToken = vm.envAddress("RESERVE_TOKEN");
        address reserveToken = s_reserveToken;
        s_router = vm.envOr("UNISWAP_V2_ROUTER", address(0));
        address router = s_router;
        address pool = vm.envOr("UNISWAP_V2_POOL", address(0));
        address portfolioManager = vm.envOr("PORTFOLIO_MANAGER", address(0));
        address leaderboard = vm.envOr("LEADERBOARD", address(0));

        vm.startBroadcast(pk);
        console2.log("Deployer:", s_deployer);
        console2.log("Safe (governor admin backstop):", s_safe);

        _deployCore(reserveToken, pool);
        _deployKernelStack(reserveToken);
        _deployStakingAndPolicies();
        _deployFly(reserveToken, router, portfolioManager, leaderboard);
        _wire(reserveToken);
        _logSummary();
        vm.stopBroadcast();
    }

    // ======== Phase 1: Core token + oracles ========
    function _deployCore(address reserveToken, address pool) internal {
        console2.log("=== Phase 1: Core ===");

        if (s_externalToken != address(0)) {
            // External launch (Tolly): sanity-check it is an ERC20.
            require(IERC20(s_externalToken).totalSupply() >= 0, "SYM_TOKEN not ERC20");
            s_symbientToken = s_externalToken;
            console2.log("SYM (external):", s_symbientToken);
        } else {
            SymbientToken symbientToken = new SymbientToken(s_safe);
            s_symbientToken = address(symbientToken);
            console2.log("SymbientToken:", s_symbientToken);
        }

        TokenRegistry registry = new TokenRegistry(s_safe);
        s_registry = address(registry);
        console2.log("TokenRegistry:", s_registry);

        TreasuryValuation valuation = new TreasuryValuation(s_safe);
        s_valuation = address(valuation);
        console2.log("TreasuryValuation:", s_valuation);

        // Price feed: TWAP if a UniV3 pool is provided, else manual feed
        if (pool != address(0)) {
            SymbientPriceFeed twap = new SymbientPriceFeed(pool, s_symbientToken, s_valuation, s_safe);
            s_priceFeed = address(twap);
            console2.log("SymbientPriceFeed (TWAP):", s_priceFeed);
        } else {
            ManualPriceFeed manual = new ManualPriceFeed(s_symbientToken, s_valuation, s_safe, 1e18, 1e18);
            s_priceFeed = address(manual);
            console2.log("ManualPriceFeed:", s_priceFeed);
        }
    }

    // ======== Phase 2: Olympus kernel stack ========
    function _deployKernelStack(address reserveToken) internal {
        console2.log("=== Phase 2: Kernel & Modules ===");

        Kernel kernel = new Kernel();
        s_kernel = address(kernel);
        console2.log("Kernel:", s_kernel);

        OlympusRoles roles = new OlympusRoles(kernel);
        kernel.executeAction(Actions.InstallModule, address(roles));
        console2.log("OlympusRoles:", address(roles));

        if (s_externalToken == address(0)) {
            OlympusMinter minter = new OlympusMinter(kernel, s_symbientToken);
            kernel.executeAction(Actions.InstallModule, address(minter));
            s_minter = address(minter);
            console2.log("OlympusMinter:", s_minter);
        } else {
            console2.log("OlympusMinter: skipped (external fixed-supply token)");
        }

        OlympusTreasury trsry = new OlympusTreasury(kernel);
        kernel.executeAction(Actions.InstallModule, address(trsry));
        s_trsry = address(trsry);
        console2.log("OlympusTreasury:", s_trsry);

        TreasuryValuation(s_valuation).setReserveTreasury(s_trsry);

        // RANGE bound-stability params module (pair token = reserve)
        OlympusRange range = new OlympusRange(
            kernel,
            SolmateERC20(s_symbientToken),
            SolmateERC20(reserveToken),
            5000,                      // thresholdFactor
            [uint256(200), uint256(600)], // cushion spreads
            [uint256(200), uint256(600)]  // wall spreads
        );
        kernel.executeAction(Actions.InstallModule, address(range));
        s_range = address(range);
        console2.log("OlympusRange:", s_range);

        // PRICE module fork
        // NOTE: SymbientPrice expects (kernel, feed, obsFreq, maDuration, minTarget, admin)
        SymbientPrice price = new SymbientPrice(kernel, s_priceFeed, 8 hours, 7 days, 1e18, s_safe);
        kernel.executeAction(Actions.InstallModule, address(price));
        s_price = address(price);
        console2.log("SymbientPrice:", s_price);
    }

    // ======== Phase 3: Staking + policies ========
    function _deployStakingAndPolicies() internal {
        console2.log("=== Phase 3: Staking & Policies ===");

        SymbientStaking staking = new SymbientStaking(s_symbientToken, s_priceFeed, s_valuation, s_safe);
        s_staking = address(staking);
        console2.log("SymbientStaking:", s_staking);

        WstSYM wst = new WstSYM(s_staking);
        s_wstSymbient = address(wst);
        console2.log("wstSYM:", s_wstSymbient);

        // Fee router: Tolly creator fees (USDC) → market-buy SYM → rewardPool.
        // Only useful with an external launch; skipped when router/reserve unset.
        if (s_externalToken != address(0) && s_router != address(0) && s_reserveToken != address(0)) {
            SymbientFeeRouter feeRouter = new SymbientFeeRouter(
                s_reserveToken,
                s_symbientToken,
                s_router,
                s_staking,
                vm.envOr("TOLLY_LOCKER", address(0)),
                address(0), // treasury wired in _wire (TRSRY deploys in phase 2)
                s_safe
            );
            s_feeRouter = address(feeRouter);
            console2.log("SymbientFeeRouter:", s_feeRouter);
        }

        StakingAdapter adapter = new StakingAdapter(s_symbientToken, s_staking, s_wstSymbient);
        s_stakingAdapter = address(adapter);
        console2.log("StakingAdapter:", s_stakingAdapter);

        Kernel kernel = Kernel(s_kernel);

        // GovernorPolicy -- the module bridge owned by the governor
        GovernorPolicy govPolicy = new GovernorPolicy(kernel);
        kernel.executeAction(Actions.ActivatePolicy, address(govPolicy));
        s_governorPolicy = address(govPolicy);
        console2.log("GovernorPolicy:", s_governorPolicy);

        // PriceInitializer -- one-shot PRICE init
        PriceInitializer priceInit = new PriceInitializer(kernel);
        kernel.executeAction(Actions.ActivatePolicy, address(priceInit));
        console2.log("PriceInitializer:", address(priceInit));

        // Distributor + Heart
        SymbientDistributor distributor = new SymbientDistributor(s_staking, s_stakingAdapter);
        s_distributor = address(distributor);
        console2.log("SymbientDistributor:", s_distributor);

        // External fixed-supply SYM has no MINTR — use the mint-free heart.
        if (s_externalToken == address(0)) {
            OlympusHeart heart = new OlympusHeart(kernel, distributor, 1e18, 30 minutes);
            kernel.executeAction(Actions.ActivatePolicy, address(heart));
            s_heart = address(heart);
            console2.log("OlympusHeart:", s_heart);
        } else {
            SymbientHeart heart = new SymbientHeart(kernel, distributor);
            kernel.executeAction(Actions.ActivatePolicy, address(heart));
            s_heart = address(heart);
            console2.log("SymbientHeart:", s_heart);
        }

        // Defense budget -- gates RBS operate() on circuit breaker + budget
        SymbientDefenseBudget budget = new SymbientDefenseBudget(kernel, address(0), s_trsry, s_symbientToken, s_safe);
        kernel.executeAction(Actions.ActivatePolicy, address(budget));
        s_defenseBudget = address(budget);
        console2.log("SymbientDefenseBudget:", s_defenseBudget);

        RolesAdmin rolesAdmin = new RolesAdmin(kernel);
        kernel.executeAction(Actions.ActivatePolicy, address(rolesAdmin));
        s_rolesAdmin = address(rolesAdmin);
        console2.log("RolesAdmin:", s_rolesAdmin);

        // External fixed-supply SYM has no MINTR — TRSRY-only emergency policy.
        if (s_externalToken == address(0)) {
            Emergency emergency = new Emergency(kernel);
            kernel.executeAction(Actions.ActivatePolicy, address(emergency));
            console2.log("Emergency:", address(emergency));
        } else {
            SymbientEmergency emergency = new SymbientEmergency(kernel);
            kernel.executeAction(Actions.ActivatePolicy, address(emergency));
            console2.log("SymbientEmergency:", address(emergency));
        }

        TreasuryCustodian custodian = new TreasuryCustodian(kernel);
        kernel.executeAction(Actions.ActivatePolicy, address(custodian));
        console2.log("TreasuryCustodian:", address(custodian));

        // Circuit breaker -- SYM spot vs floor
        SymbientCircuitBreaker cb = new SymbientCircuitBreaker(s_safe);
        cb.setSymbientToken(s_symbientToken);
        cb.setPriceFeed(s_priceFeed);
        cb.setValuation(s_valuation);
        s_circuitBreaker = address(cb);
        console2.log("SymbientCircuitBreaker:", s_circuitBreaker);
        budget.setCircuitBreaker(s_circuitBreaker);

        // Bond pricer (dynamic discount for RBS bond markets)
        SymbientBondPricer pricer = new SymbientBondPricer(s_valuation, s_safe);
        console2.log("SymbientBondPricer:", address(pricer));

        // Inverse bond -- standing buyback at floor x (1 - 1.5%), burns SYM
        // treasury = GovernorPolicy (governor funds the float via TRSRY + approveToken)
        SymbientInverseBond bond = new SymbientInverseBond(
            s_symbientToken, reserveTokenForBond(), s_governorPolicy, s_valuation, s_safe
        );
        bond.setCircuitBreaker(s_circuitBreaker);
        s_inverseBond = address(bond);
        console2.log("SymbientInverseBond:", s_inverseBond);
    }

    function reserveTokenForBond() internal view returns (address) {
        // payout token = reserve (USDC); stored for readability
        return vm.envAddress("RESERVE_TOKEN");
    }

    // ======== Phase 4: Fly system ========
    function _deployFly(address reserveToken, address router, address portfolioManager, address leaderboard) internal {
        console2.log("=== Phase 4: Fly System ===");

        // FlyEngine (UUPS proxy)
        FlyEngine engineImpl = new FlyEngine();
        ERC1967Proxy engineProxy = new ERC1967Proxy(
            address(engineImpl),
            abi.encodeCall(FlyEngine.initialize, (s_safe))
        );
        console2.log("FlyEngine:", address(engineProxy));

        // ConnectomeGovernor (UUPS proxy) -- the connectome-consensus executor
        ConnectomeGovernor govImpl = new ConnectomeGovernor();
        ERC1967Proxy govProxy = new ERC1967Proxy(
            address(govImpl),
            abi.encodeCall(ConnectomeGovernor.initialize, (s_safe, address(engineProxy)))
        );
        s_governor = address(govProxy);
        console2.log("ConnectomeGovernor:", s_governor);

        GovernorPolicy(s_governorPolicy).setGovernor(s_governor);

        StakingVault vault = new StakingVault(s_symbientToken, s_safe);
        s_stakingVault = address(vault);
        console2.log("StakingVault:", s_stakingVault);

        ArcLaunchpadAdapter adapter = new ArcLaunchpadAdapter(router, reserveToken, s_safe);
        adapter.setTreasury(s_trsry);
        s_adapter = address(adapter);
        console2.log("ArcLaunchpadAdapter:", s_adapter);

        TreasuryAllocator allocator = new TreasuryAllocator(reserveToken, s_safe);
        s_allocator = address(allocator);
        console2.log("TreasuryAllocator:", s_allocator);

        // Strategies -- default targets: RBS 40% / MEME 20% / YIELD 20% / SAFE 20%
        RBSStrategy rbs = new RBSStrategy(reserveToken, address(0));
        MemecoinStrategy meme = new MemecoinStrategy(reserveToken, s_adapter);
        YieldFarmingStrategy yield_ = new YieldFarmingStrategy(reserveToken, s_symbientToken, router, vm.envOr("UNISWAP_V2_POOL", address(0)));
        SafeHavenStrategy safe = new SafeHavenStrategy(reserveToken);

        allocator.registerStrategy("RBS", address(rbs), type(uint256).max, 4000);
        allocator.registerStrategy("MEME", address(meme), type(uint256).max, 2000);
        allocator.registerStrategy("YIELD", address(yield_), type(uint256).max, 2000);
        allocator.registerStrategy("SAFE", address(safe), type(uint256).max, 2000);
        console2.log("4 strategies registered");

        DecisionLedger ledger = new DecisionLedger(s_safe);
        ledger.setGovernor(s_governor);
        s_decisionLedger = address(ledger);
        console2.log("DecisionLedger:", s_decisionLedger);

        if (portfolioManager != address(0)) {
            PerformanceBridge bridge = new PerformanceBridge(portfolioManager, leaderboard, s_safe);
            s_performanceBridge = address(bridge);
            console2.log("PerformanceBridge:", s_performanceBridge);
        }
    }

    // ======== Phase 5: Wire governor as operator of everything ========
    function _wire(address) internal {
        console2.log("=== Phase 5: Wiring: governor becomes the operator ===");

        Kernel kernel = Kernel(s_kernel);
        RolesAdmin rolesAdmin = RolesAdmin(s_rolesAdmin);

        // 1. Deployer is RolesAdmin's initial admin -- grant "admin" role to self
        //    so Heart/policy admin calls work during setup.
        rolesAdmin.grantRole("admin", s_deployer);
        rolesAdmin.grantRole("heart", s_defenseBudget); // budget is a Heart periodic task
        rolesAdmin.grantRole("heart", s_deployer);

        // 2. Governor = kernel executor (can install/activate/migrate via proposals)
        kernel.executeAction(Actions.ChangeExecutor, s_governor);
        console2.log("Kernel executor -> governor");

        // 3. All operational roles -> governor (connectomes control policies)
        rolesAdmin.grantRole("admin", s_governor);
        rolesAdmin.grantRole("emergency_shutdown", s_governor);
        rolesAdmin.grantRole("emergency_restart", s_governor);
        rolesAdmin.grantRole("custodian", s_governor);
        rolesAdmin.grantRole("operator_admin", s_governor);
        rolesAdmin.grantRole("operator_policy", s_governor);
        rolesAdmin.pushNewAdmin(s_governor); // governor pulls via proposal
        console2.log("All roles -> governor");

        // 4. Heart periodic tasks + enable (shared bases on both heart variants)
        BasePeriodicTaskManager(s_heart).addPeriodicTask(s_distributor);   // rebase every beat
        BasePeriodicTaskManager(s_heart).addPeriodicTask(s_defenseBudget); // RBS budget check
        PolicyEnabler(s_heart).enable("");
        console2.log("Heart enabled, periodic tasks registered");

        // 5. Governor role grants on standalone contracts -- requires MULTISIG_ROLE admin
        if (s_feeRouter != address(0) && s_trsry != address(0)) {
            if (s_safe == s_deployer) {
                SymbientFeeRouter(s_feeRouter).setTreasury(s_trsry);
                // GovernorPolicy gets GOVERNANCE_ROLE: connectome proposals call
                // feeRouter.fundRewards through policy.executeModule
                SymbientFeeRouter(s_feeRouter).grantRole(
                    SymbientFeeRouter(s_feeRouter).GOVERNANCE_ROLE(), s_governorPolicy
                );
            } else {
                console2.log("POST-DEPLOY (Safe): feeRouter.setTreasury(", s_trsry, ")");
                console2.log("POST-DEPLOY (Safe): feeRouter.grantRole(GOVERNANCE_ROLE,", s_governorPolicy, ")");
            }
        }

        if (s_safe == s_deployer) {
            _grantGovernorRoles();
        } else {
            console2.log("POST-DEPLOY (Safe): grant governor MULTISIG/GOVERNANCE roles on:");
            console2.log("  SymbientToken:", s_symbientToken);
            console2.log("  TreasuryValuation:", s_valuation);
            console2.log("  TokenRegistry:", s_registry);
            console2.log("  SymbientStaking:", s_staking);
            console2.log("  SymbientCircuitBreaker:", s_circuitBreaker);
            console2.log("  SymbientInverseBond:", s_inverseBond);
            console2.log("  SymbientFeeRouter:", s_feeRouter);
            console2.log("  SymbientDefenseBudget:", s_defenseBudget);
            console2.log("  ArcLaunchpadAdapter:", s_adapter);
            console2.log("  TreasuryAllocator:", s_allocator);
        }

        // 6. Connectome EOAs get KEEPER_ROLE (bounded autonomous trading)
        //    (only when deployer holds admin on those contracts)
        if (s_safe == s_deployer) {
            _grantConnectomeKeepers();
        }

        // 7. MINTR authorized as minter (protocol-mintable token only;
        //    external launches have no protocol mint path)
        if (s_externalToken == address(0)) {
            if (s_safe == s_deployer) {
                SymbientToken(s_symbientToken).setAuthorizedMinter(s_minter);
            } else {
                console2.log("POST-DEPLOY (Safe): symbientToken.setAuthorizedMinter(", s_minter, ")");
            }
        }
    }

    function _grantGovernorRoles() internal {
        if (s_externalToken == address(0)) {
            SymbientToken(s_symbientToken).grantRole(SymbientToken(s_symbientToken).MULTISIG_ROLE(), s_governor);
        }
        TreasuryValuation(s_valuation).grantRole(TreasuryValuation(s_valuation).MULTISIG_ROLE(), s_governor);
        TokenRegistry(s_registry).grantRole(TokenRegistry(s_registry).MANAGER_ROLE(), s_governor);
        SymbientStaking(s_staking).grantRole(SymbientStaking(s_staking).MULTISIG_ROLE(), s_governor);
        SymbientCircuitBreaker(s_circuitBreaker).grantRole(SymbientCircuitBreaker(s_circuitBreaker).MULTISIG_ROLE(), s_governor);
        SymbientInverseBond(s_inverseBond).grantRole(SymbientInverseBond(s_inverseBond).MULTISIG_ROLE(), s_governor);
        SymbientDefenseBudget(s_defenseBudget).grantRole(SymbientDefenseBudget(s_defenseBudget).MULTISIG_ROLE(), s_governor);
        ArcLaunchpadAdapter(s_adapter).grantRole(ArcLaunchpadAdapter(s_adapter).GOVERNANCE_ROLE(), s_governor);
        TreasuryAllocator(s_allocator).grantRole(TreasuryAllocator(s_allocator).GOVERNANCE_ROLE(), s_governor);
        ArcLaunchpadAdapter(s_adapter).grantRole(ArcLaunchpadAdapter(s_adapter).KEEPER_ROLE(), s_governor);
        TreasuryAllocator(s_allocator).grantRole(TreasuryAllocator(s_allocator).KEEPER_ROLE(), s_governor);
        console2.log("Governor -> MULTISIG/GOVERNANCE/KEEPER roles on all contracts");
    }

    function _grantConnectomeKeepers() internal {
        address[] memory voters = vm.envOr("CONNECTOME_VOTERS", ",", new address[](0));
        for (uint256 i = 0; i < voters.length; i++) {
            ArcLaunchpadAdapter(s_adapter).grantRole(ArcLaunchpadAdapter(s_adapter).KEEPER_ROLE(), voters[i]);
            TreasuryAllocator(s_allocator).grantRole(TreasuryAllocator(s_allocator).KEEPER_ROLE(), voters[i]);
            if (s_feeRouter != address(0)) {
                SymbientFeeRouter(s_feeRouter).grantRole(SymbientFeeRouter(s_feeRouter).KEEPER_ROLE(), voters[i]);
            }
        }
        console2.log("Connectome EOAs -> KEEPER_ROLE (count:", voters.length, ")");
    }

    function _logSummary() internal view {
        console2.log("=== SIMPLIFIED DEPLOYMENT COMPLETE ===");
        console2.log("SYM:", s_symbientToken);
        console2.log("stSYM:", s_staking);
        console2.log("wstSYM:", s_wstSymbient);
        console2.log("Kernel:", s_kernel);
        console2.log("TRSRY:", s_trsry);
        console2.log("RANGE:", s_range);
        console2.log("PRICE:", s_price);
        console2.log("Heart:", s_heart);
        console2.log("ConnectomeGovernor:", s_governor);
        console2.log("GovernorPolicy:", s_governorPolicy);
        console2.log("TreasuryAllocator:", s_allocator);
        console2.log("ArcLaunchpadAdapter:", s_adapter);
        console2.log("StakingVault:", s_stakingVault);
        console2.log("InverseBond (buyback):", s_inverseBond);
        console2.log("CircuitBreaker:", s_circuitBreaker);
        console2.log("DecisionLedger:", s_decisionLedger);
    }
}

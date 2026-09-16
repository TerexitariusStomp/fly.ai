// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Kernel, Actions} from "@olympus-v3/Kernel.sol";
import {OlympusRoles} from "@olympus-v3/modules/ROLES/OlympusRoles.sol";
import {OlympusTreasury} from "@olympus-v3/modules/TRSRY/OlympusTreasury.sol";

import {SymbientToken} from "../src/SymbientToken.sol";
import {WstSYM} from "../src/wstSYM.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {SymbientDeployer} from "../src/SymbientDeployer.sol";
import {TokenRegistry} from "../src/TokenRegistry.sol";
import {SymbientStaking} from "../src/SymbientStaking.sol";
import {StakingAdapter} from "../src/StakingAdapter.sol";
import {SymbientPriceFeed} from "../src/SymbientPriceFeed.sol";
import {IPriceFeed} from "../src/IPriceFeed.sol";
import {ITreasuryPolicy} from "../src/ITreasuryPolicy.sol";
import {TreasuryValuation} from "../src/TreasuryValuation.sol";
import {SymbientInverseBond} from "../src/SymbientInverseBond.sol";
import {SymbientCircuitBreaker} from "../src/SymbientCircuitBreaker.sol";
import {SymbientDefenseBudget} from "../src/SymbientDefenseBudget.sol";
import {SymbientBondPricer} from "../src/SymbientBondPricer.sol";
import {ConnectomeGovernor, IFlyEngine} from "../src/fly/ConnectomeGovernor.sol";
import {GovernorPolicy} from "../src/fly/GovernorPolicy.sol";
import {SymbientFeeRouter} from "../src/SymbientFeeRouter.sol";

// ==================== MOCKS ====================

contract ERC20Mock is ERC20 {
    uint8 private _decimals;
    constructor(string memory n, string memory s, uint8 d) ERC20(n, s) { _decimals = d; }
    function decimals() public view override returns (uint8) { return _decimals; }
    function mint(address to, uint256 a) external virtual { _mint(to, a); }
    function burn(address f, uint256 a) external { _burn(f, a); }
    function burn(uint256 a) external { _burn(msg.sender, a); }
}

contract MockERC20Simple is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) {}
    function mint(address to, uint256 a) external { _mint(to, a); }
}

/// @notice Simulates an externally launched token (e.g. via Tolly) — full supply
///         minted at deploy, no mint/burn functions at all.
contract FixedSupplyToken is ERC20 {
    constructor(string memory n, string memory s, uint256 supply_) ERC20(n, s) {
        _mint(msg.sender, supply_);
    }
}

contract MockV3Pool {
    uint160 public sqrtPriceX96;
    uint16 public observationCardinality;
    int56[] public tickCumulatives;
    function setSqrtPriceX96(uint160 v) external { sqrtPriceX96 = v; }
    function setObservationCardinality(uint16 v) external { observationCardinality = v; }
    function setTickCumulatives(int56[] memory v) external { tickCumulatives = v; }
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (sqrtPriceX96, 0, 0, observationCardinality, 0, 0, false);
    }
    function observe(uint32[] calldata) external view returns (int56[] memory, uint160[] memory) {
        int56[] memory c = new int56[](2);
        c[0] = tickCumulatives[0]; c[1] = tickCumulatives[1];
        uint160[] memory s = new uint160[] (2);
        return (c, s);
    }
}

contract MockTreasuryPolicyForFeed {
    function navPerSymbient() external pure returns (uint256) { return 0; }
    function floorPrice() external pure returns (uint256) { return 0; }
    function rfv() external pure returns (uint256) { return 0; }
    function enforceRfvInvariant(uint256) external view {}
}

contract TestPriceFeed is IPriceFeed {
    function getTokenPrice(address) external pure returns (uint256) { return 1e18; }
    function getNavPerToken() external pure returns (uint256) { return 1e18; }
}

contract TestTreasuryPolicy is ITreasuryPolicy {
    function enforceRfvInvariant(uint256) external pure {}
    function floorPrice() external pure returns (uint256) { return 1e18; }
    function navPerSymbient() external pure returns (uint256) { return 1e18; }
    function rfv() external pure returns (uint256) { return 1e18; }
}

contract CBMockPriceFeed {
    uint256 public spotPrice;
    function setPrice(uint256 p) external { spotPrice = p; }
    function getTokenPrice(address) external view returns (uint256) { return spotPrice; }
}

contract CBMockTreasuryPolicy {
    uint256 public rfv;
    uint256 public floorPrice;
    uint256 public navPerSymbient;
    function setRfv(uint256 v) external { rfv = v; }
    function setFloorPrice(uint256 v) external { floorPrice = v; }
    function setNavPerSymbient(uint256 v) external { navPerSymbient = v; }
}

contract CBMockOperator {
    bool public operateCalled;
    function operate() external { operateCalled = true; }
}

/// @notice Mock FlyEngine — returns preset decisions per connectome for governor tests
contract MockFlyEngine {
    mapping(bytes32 => int8) public actions;
    mapping(bytes32 => uint8) public confidences;

    function setDecision(bytes32 connectomeId, int8 action, uint8 confidence) external {
        actions[connectomeId] = action;
        confidences[connectomeId] = confidence;
    }

    function analyze(bytes32 connectomeId, IFlyEngine.MarketData calldata, uint8)
        external
        returns (IFlyEngine.Decision memory)
    {
        return IFlyEngine.Decision({
            action: actions[connectomeId],
            confidence: confidences[connectomeId],
            connectomeId: connectomeId
        });
    }
}

/// @notice Target contract whose call governor proposals execute
contract MockGovernanceTarget {
    uint256 public value;
    bool public called;
    function setValue(uint256 v) external { value = v; called = true; }
}

contract ERC1967Proxy {
    bytes32 internal constant _SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    constructor(address impl, bytes memory data) {
        assembly { sstore(_SLOT, impl) }
        (bool ok,) = impl.delegatecall(data);
        require(ok, "init failed");
    }
    fallback() external payable {
        assembly {
            let impl := sload(_SLOT)
            calldatacopy(0, 0, calldatasize())
            let r := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch r
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }
}

// ==================== TOKEN TESTS ====================

contract SymbientTokenTest is Test {
    SymbientToken public symbientToken;
    WstSYM public govToken;
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public multisig = makeAddr("multisig");

    function setUp() public {
        symbientToken = new SymbientToken(address(this));
        govToken = new WstSYM(address(symbientToken));
    }

    function testTokenMetadata() public view {
        assertEq(symbientToken.name(), "SYM");
        assertEq(symbientToken.symbol(), "SYM");
        assertEq(symbientToken.decimals(), 18);
    }

    function testMintAndBurn() public {
        symbientToken.mint(alice, 100e18);
        assertEq(symbientToken.balanceOf(alice), 100e18);
        vm.prank(alice);
        symbientToken.burn(40e18);
        assertEq(symbientToken.balanceOf(alice), 60e18);
    }

    function testBurnFrom() public {
        symbientToken.mint(alice, 100e18);
        vm.prank(alice);
        symbientToken.approve(bob, 50e18);
        vm.prank(bob);
        symbientToken.burnFrom(alice, 30e18);
        assertEq(symbientToken.balanceOf(alice), 70e18);
    }

    function testMaxSupply() public {
        symbientToken.mint(alice, 100_000_000e18);
        vm.expectRevert(SymbientToken.MaxSupplyExceeded.selector);
        symbientToken.mint(alice, 1);
    }

    function testOnlyMinterCanMint() public {
        vm.prank(alice);
        vm.expectRevert();
        symbientToken.mint(alice, 100e18);
    }

    function testConstructorRevertZeroAddress() public {
        vm.expectRevert();
        new SymbientToken(address(0));
    }

    function testSetAuthorizedMinter() public {
        SymbientToken token = new SymbientToken(multisig);
        address minter = makeAddr("minter");
        vm.prank(multisig);
        token.setAuthorizedMinter(minter);
        assertEq(token.authorizedMinter(), minter);
        vm.prank(minter);
        token.mint(makeAddr("to"), 100e18);
        assertEq(token.totalSupply(), 100e18);
    }
}

contract TokenRegistryTest is Test {
    TokenRegistry registry;
    MockERC20Simple tokenA;
    address admin = address(this);

    function setUp() public {
        registry = new TokenRegistry(admin);
        tokenA = new MockERC20Simple("Token A", "TKA");
    }

    function testRegistryWhitelist() public {
        assertFalse(registry.isWhitelisted(address(tokenA)));
        registry.whitelist(address(tokenA));
        assertTrue(registry.isWhitelisted(address(tokenA)));
    }

    function testRegistryRemove() public {
        registry.whitelist(address(tokenA));
        registry.remove(address(tokenA));
        assertFalse(registry.isWhitelisted(address(tokenA)));
    }

    function testRegistryNotContract() public {
        vm.expectRevert(abi.encodeWithSelector(TokenRegistry.NotAContract.selector, address(0xDEAD)));
        registry.whitelist(address(0xDEAD));
    }
}

contract SymbientDeployerTest is Test {
    function testConstructor() public {
        SymbientDeployer d = new SymbientDeployer();
        assertTrue(d.hasRole(d.DEFAULT_ADMIN_ROLE(), address(this)));
    }

    function testDeployCreate2() public {
        SymbientDeployer d = new SymbientDeployer();
        bytes memory code = abi.encodePacked(type(ERC20Mock).creationCode, abi.encode("T", "T", 18));
        address addr = d.deployCreate2(code, bytes32(uint256(1)));
        assertTrue(addr != address(0));
    }

    function testDeployCreate2RevertNotManager() public {
        SymbientDeployer d = new SymbientDeployer();
        vm.prank(makeAddr("no"));
        vm.expectRevert();
        d.deployCreate2("", bytes32(0));
    }
}

// ==================== STAKING TESTS ====================

contract SymbientStakingTest is Test {
    ERC20Mock symbient;
    SymbientStaking staking;
    address multisig;

    function setUp() public {
        symbient = new ERC20Mock("SYM", "SYM", 18);
        multisig = makeAddr("multisig");
        staking = new SymbientStaking(address(symbient), address(new TestPriceFeed()), address(new TestTreasuryPolicy()), multisig);
    }

    function testConstructor() public {
        assertEq(address(staking.symbientToken()), address(symbient));
        assertEq(staking.index(), 1e18);
    }

    function testStake() public {
        symbient.mint(address(this), 100e18);
        symbient.approve(address(staking), 100e18);
        uint256 st = staking.stake(100e18);
        assertEq(st, 100e18);
    }

    function testUnstake() public {
        symbient.mint(address(this), 100e18);
        symbient.approve(address(staking), 100e18);
        staking.stake(100e18);
        uint256 r = staking.unstake(50e18);
        assertEq(r, 50e18);
    }

    function testRebaseEmptySupply() public {
        vm.warp(block.timestamp + 8 hours + 1);
        staking.rebase();
        (, uint256 num, , ) = staking.epoch();
        assertEq(num, 1);
    }

    function testRebaseWithStaked() public {
        symbient.mint(address(this), 100e18);
        symbient.approve(address(staking), 100e18);
        staking.stake(100e18);
        symbient.mint(address(staking), 10e18);
        vm.warp(block.timestamp + 8 hours + 1);
        staking.rebase();
        assertGt(staking.index(), 1e18);
    }

    function testPauseRevertNotMultisig() public {
        vm.expectRevert(abi.encodeWithSelector(
            bytes4(keccak256("AccessControlUnauthorizedAccount(address,bytes32)")),
            address(this),
            staking.MULTISIG_ROLE()
        ));
        staking.pause();
    }
}

contract WstSYMTest is Test {
    WstSYM public wstSymbient;
    ERC20Mock public stSymbient;

    function setUp() public {
        stSymbient = new ERC20Mock("stSYM", "stSYM", 18);
        wstSymbient = new WstSYM(address(stSymbient));
    }

    function testConstructor() public {
        assertEq(address(wstSymbient.stSYM()), address(stSymbient));
        assertEq(wstSymbient.name(), "Wrapped staked SYM");
    }

    function testWrap() public {
        stSymbient.mint(address(this), 100e18);
        stSymbient.approve(address(wstSymbient), 100e18);
        assertEq(wstSymbient.wrap(100e18), 100e18);
    }

    function testUnwrap() public {
        stSymbient.mint(address(this), 100e18);
        stSymbient.approve(address(wstSymbient), 100e18);
        wstSymbient.wrap(100e18);
        assertEq(wstSymbient.unwrap(50e18), 50e18);
    }
}

contract StakingWrapperTest is Test {
    SymbientStaking public staking;
    SymbientToken public symbientToken;
    SymbientPriceFeed public priceFeed;
    TreasuryValuation public treasuryPolicy;
    WstSYM public wstSymbient;
    StakingAdapter public stakingAdapter;
    MockV3Pool public pool;
    address public safe = address(this);
    address public user = makeAddr("user");

    function setUp() public {
        symbientToken = new SymbientToken(safe);
        pool = new MockV3Pool();
        pool.setSqrtPriceX96(79228162514264337593543950336);
        pool.setObservationCardinality(2);
        int56[] memory cum = new int56[](2);
        cum[0] = 0; cum[1] = 100;
        pool.setTickCumulatives(cum);
        treasuryPolicy = new TreasuryValuation(safe);
        priceFeed = new SymbientPriceFeed(address(pool), address(symbientToken), address(treasuryPolicy), safe);
        Kernel kernel = new Kernel();
        kernel.executeAction(Actions.ChangeExecutor, safe);
        staking = new SymbientStaking(address(symbientToken), address(priceFeed), address(treasuryPolicy), safe);
        wstSymbient = new WstSYM(address(staking));
        stakingAdapter = new StakingAdapter(address(symbientToken), address(staking), address(wstSymbient));
        symbientToken.mint(user, 1000e18);
        vm.startPrank(user);
        symbientToken.approve(address(staking), type(uint256).max);
        symbientToken.approve(address(stakingAdapter), type(uint256).max);
        staking.approve(address(wstSymbient), type(uint256).max);
        vm.stopPrank();
    }

    function testStakingAdapterStake() public {
        vm.prank(user);
        uint256 wst = stakingAdapter.stake(user, 100e18, false, false);
        assertEq(wst, 100e18);
    }

    function testStakingAdapterUnstake() public {
        vm.startPrank(user);
        uint256 wst = stakingAdapter.stake(user, 100e18, false, false);
        wstSymbient.approve(address(stakingAdapter), wst);
        uint256 r = stakingAdapter.unstake(user, wst, false, false);
        vm.stopPrank();
        assertEq(r, 100e18);
    }
}

// ==================== TREASURY TESTS ====================

contract TreasuryValuationTest is Test {
    TreasuryValuation policy;
    address multisig = makeAddr("multisig");

    function setUp() public { policy = new TreasuryValuation(multisig); }

    function testConstructor() public { assertTrue(policy.hasRole(policy.MULTISIG_ROLE(), multisig)); }

    function testSetValuations() public {
        vm.prank(multisig);
        policy.setValuations(100e6, 200e6, 1000e18);
        assertEq(policy.rfv(), 100e6);
        assertGt(policy.floorPrice(), 0);
    }

    function testEnforceRfvInvariantFail() public {
        vm.prank(multisig);
        policy.setValuations(1000e6, 1000e6, 10e18);
        vm.expectRevert(abi.encodeWithSelector(TreasuryValuation.RfvInvariantFailed.selector, 10000e6, 1000e6));
        policy.enforceRfvInvariant(100e18);
    }

    function testRfvBypass() public {
        vm.prank(multisig);
        policy.setValuations(1000e6, 1000e6, 10e18);
        vm.prank(multisig);
        policy.setRfvBypass(true);
        policy.enforceRfvInvariant(100e18);
    }
}

// ==================== ORACLE TESTS ====================

contract SymbientPriceFeedTest is Test {
    SymbientPriceFeed feed;
    MockV3Pool pool;

    function setUp() public {
        pool = new MockV3Pool();
        feed = new SymbientPriceFeed(address(pool), address(0xA111), address(new MockTreasuryPolicyForFeed()), address(this));
    }

    function testSpotPrice() public {
        pool.setSqrtPriceX96(79228162514264337593543950336);
        assertApproxEqAbs(feed.spotPrice(), 1e18, 1e15);
    }

    function testFuzzSpotPrice(uint96 sqrt) public {
        vm.assume(sqrt > 0);
        pool.setSqrtPriceX96(uint160(sqrt));
        assertEq(feed.spotPrice(), (uint256(sqrt) * uint256(sqrt) * 1e18) >> 192);
    }
}

// ==================== BOND TESTS ====================

contract SymbientInverseBondTest is Test {
    SymbientInverseBond public inverseBond;
    ERC20Mock public symbientToken;
    ERC20Mock public payoutToken;
    CBMockTreasuryPolicy public valuation;
    address public treasury = makeAddr("treasury");
    address public admin = makeAddr("admin");
    address public seller = makeAddr("seller");

    function setUp() public {
        symbientToken = new ERC20Mock("SYM", "SYM", 18);
        payoutToken = new ERC20Mock("USDC", "USDC", 6);
        valuation = new CBMockTreasuryPolicy();
        inverseBond = new SymbientInverseBond(address(symbientToken), address(payoutToken), treasury, address(valuation), admin);
    }

    function testConstructor() public {
        assertEq(address(inverseBond.symbientToken()), address(symbientToken));
        assertEq(address(inverseBond.valuation()), address(valuation));
    }

    function testSellSuccessAtFloor() public {
        // floor = 2e6, rfv = 1_000_000e6 → price = 2e6 * 0.985 = 1.97e6, capacity = 1% of rfv
        valuation.setFloorPrice(2e6);
        valuation.setRfv(1_000_000e6);
        symbientToken.mint(seller, 100e18);
        payoutToken.mint(treasury, 100000e6);
        vm.prank(treasury);
        payoutToken.approve(address(inverseBond), type(uint256).max);
        vm.startPrank(seller);
        symbientToken.approve(address(inverseBond), 100e18);
        uint256 payout = inverseBond.sell(100e18);
        vm.stopPrank();
        assertEq(payout, (100e18 * ((2e6 * 9850) / 10000)) / 1e18);
        // SYM was burned
        assertEq(symbientToken.balanceOf(address(inverseBond)), 0);
    }

    function testSellRevertsWhenFloorZero() public {
        valuation.setFloorPrice(0);
        valuation.setRfv(1_000_000e6);
        symbientToken.mint(seller, 100e18);
        vm.startPrank(seller);
        symbientToken.approve(address(inverseBond), 100e18);
        vm.expectRevert(SymbientInverseBond.NothingToBurn.selector);
        inverseBond.sell(100e18);
        vm.stopPrank();
    }

    function testFuzzSellRespectsCapacity(uint256 symbientAmount) public {
        CBMockTreasuryPolicy v = new CBMockTreasuryPolicy();
        v.setFloorPrice(2e18);
        v.setRfv(1e24);
        SymbientInverseBond bond = new SymbientInverseBond(address(symbientToken), address(payoutToken), treasury, address(v), admin);
        vm.assume(symbientAmount > 0 && symbientAmount < 1e20);
        uint256 payoutAmount = (symbientAmount * bond.bondPrice()) / 1e18;
        vm.assume(payoutAmount <= bond.epochCapacity());
        symbientToken.mint(address(this), symbientAmount);
        symbientToken.approve(address(bond), symbientAmount);
        payoutToken.mint(treasury, payoutAmount * 2);
        vm.prank(treasury);
        payoutToken.approve(address(bond), payoutAmount * 2);
        uint256 before = payoutToken.balanceOf(address(this));
        bond.sell(symbientAmount);
        assertEq(payoutToken.balanceOf(address(this)) - before, payoutAmount);
    }
}

// ==================== SECURITY TESTS ====================

contract SymbientCircuitBreakerTest is Test {
    SymbientCircuitBreaker breaker;
    SymbientDefenseBudget budget;
    SymbientBondPricer pricer;
    CBMockPriceFeed priceFeed;
    CBMockTreasuryPolicy treasuryPolicy;
    CBMockOperator operator;
    ERC20Mock symbient;
    address multisig = address(this);
    address treasury = address(0xBEEF);

    function setUp() public {
        priceFeed = new CBMockPriceFeed();
        priceFeed.setPrice(1e18);
        treasuryPolicy = new CBMockTreasuryPolicy();
        treasuryPolicy.setRfv(1_000_000e18);
        treasuryPolicy.setFloorPrice(1e18);
        operator = new CBMockOperator();
        symbient = new ERC20Mock("SYM", "SYM", 18);
        breaker = new SymbientCircuitBreaker(multisig);
        breaker.setSymbientToken(address(symbient));
        breaker.setPriceFeed(address(priceFeed));
        breaker.setValuation(address(treasuryPolicy));
        Kernel kernel = new Kernel();
        OlympusRoles roles = new OlympusRoles(kernel);
        kernel.executeAction(Actions.InstallModule, address(roles));
        budget = new SymbientDefenseBudget(kernel, address(operator), treasury, address(symbient), multisig);
        budget.updateLiquidTreasuryValue(1_000_000e18);
        kernel.executeAction(Actions.ActivatePolicy, address(budget));
        pricer = new SymbientBondPricer(address(treasuryPolicy), multisig);
    }

    function testCBTripsBelowFloor() public {
        // spot 0.97 vs floor 1.0 → 3% below → trips (2% threshold)
        priceFeed.setPrice(0.97e18);
        vm.warp(block.timestamp + 8 hours + 1);
        breaker.check();
        assertTrue(breaker.paused());
    }

    function testCBDoesNotTripAboveFloor() public {
        // spot 1.5 vs floor 1.0 → premium, not a floor break
        priceFeed.setPrice(1.5e18);
        vm.warp(block.timestamp + 8 hours + 1);
        breaker.check();
        assertFalse(breaker.paused());
    }

    function testCBManualTrip() public {
        breaker.trip();
        assertTrue(breaker.paused());
    }

    function testBudgetCurrentBudget() public { assertEq(budget.currentBudget(), 20_000e18); }

    function testBudgetExhausted() public {
        budget.recordSpending(20_000e18);
        assertFalse(budget.budgetAvailable());
    }

    function testPricerWellBacked() public {
        treasuryPolicy.setRfv(1_500_000e18);
        treasuryPolicy.setFloorPrice(1e18);
        assertEq(pricer.computeDiscount(1_000_000e18), 1000);
    }
}

// ==================== CONNECTOME GOVERNOR TESTS ====================

contract ConnectomeGovernorTest is Test {
    ConnectomeGovernor governor;
    MockFlyEngine engine;
    MockGovernanceTarget target;
    address admin = address(this);

    bytes32 constant C0 = bytes32("rosophila");
    bytes32 constant C1 = bytes32("rat");
    bytes32 constant C2 = bytes32("mouse");
    bytes32 constant C3 = bytes32("ciona");
    bytes32 constant C4 = bytes32("macaque_modha");
    bytes32 constant C5 = bytes32("human");
    bytes32 constant C6 = bytes32("celegans_male");

    IFlyEngine.MarketData market =
        IFlyEngine.MarketData({price: 1e18, volume: 0, momentum: 0, volatility: 0, signalScore: 0});

    function setUp() public {
        governor = new ConnectomeGovernor();
        engine = new MockFlyEngine();
        target = new MockGovernanceTarget();
        governor.initialize(admin, address(engine));

        bytes32[7] memory ids = [C0, C1, C2, C3, C4, C5, C6];
        for (uint256 i = 0; i < 7; i++) governor.addConnectome(ids[i], address(0));
    }

    function _proposeSetValue(uint256 v) internal returns (bytes32) {
        return governor.propose(address(target), abi.encodeCall(MockGovernanceTarget.setValue, (v)), market);
    }

    function testQuorumIs3Of7() public view {
        assertEq(governor.quorum(), 3);
    }

    function testProposalPassesAndExecutes() public {
        bytes32 pid = _proposeSetValue(42);
        engine.setDecision(C0, 1, 80);
        engine.setDecision(C1, 1, 70);
        engine.setDecision(C2, 1, 90);

        governor.vote(pid, C0);
        governor.vote(pid, C1);
        assertFalse(governor.isPassed(pid)); // only 2 of 3 needed
        governor.vote(pid, C2);
        assertTrue(governor.isPassed(pid));

        governor.execute(pid);
        assertTrue(target.called());
        assertEq(target.value(), 42);
    }

    function testAgainstVotesBlockPassage() public {
        bytes32 pid = _proposeSetValue(42);
        engine.setDecision(C0, 1, 80);
        engine.setDecision(C1, -1, 70);
        engine.setDecision(C2, -1, 90);
        engine.setDecision(C3, 1, 60);
        engine.setDecision(C4, 1, 60);
        governor.vote(pid, C0);
        governor.vote(pid, C1);
        governor.vote(pid, C2);
        governor.vote(pid, C3);
        governor.vote(pid, C4);
        // for=3, against=2 → for > against → passes at 3/7
        assertTrue(governor.isPassed(pid));
        governor.execute(pid);
        assertTrue(target.called());
    }

    function testAgainstBlocksMajority() public {
        bytes32 pid = _proposeSetValue(42);
        engine.setDecision(C0, -1, 80);
        engine.setDecision(C1, -1, 70);
        engine.setDecision(C2, -1, 90);
        engine.setDecision(C3, 1, 60);
        governor.vote(pid, C0);
        governor.vote(pid, C1);
        governor.vote(pid, C2);
        governor.vote(pid, C3);
        assertFalse(governor.isPassed(pid)); // for=1 not ≥3
        vm.expectRevert("quorum not reached");
        governor.execute(pid);
    }

    function testAbstainDoesNotCount() public {
        bytes32 pid = _proposeSetValue(42);
        engine.setDecision(C0, 0, 50); // abstain
        engine.setDecision(C1, 1, 80);
        governor.vote(pid, C0);
        governor.vote(pid, C1);
        ( , , , uint256 forVotes, uint256 againstVotes, ) = governor.getProposal(pid);
        assertEq(forVotes, 1);
        assertEq(againstVotes, 0);
    }

    function testDoubleVoteReverts() public {
        bytes32 pid = _proposeSetValue(42);
        engine.setDecision(C0, 1, 80);
        governor.vote(pid, C0);
        vm.expectRevert("already voted");
        governor.vote(pid, C0);
    }

    function testNonConnectomeVoteReverts() public {
        bytes32 pid = _proposeSetValue(42);
        vm.expectRevert("not a connectome");
        governor.vote(pid, bytes32("fake"));
    }

    function testVetoBlocksExecution() public {
        bytes32 pid = _proposeSetValue(42);
        engine.setDecision(C0, 1, 80);
        engine.setDecision(C1, 1, 70);
        engine.setDecision(C2, 1, 90);
        governor.vote(pid, C0);
        governor.vote(pid, C1);
        governor.vote(pid, C2);
        governor.vetoProposal(pid);
        vm.expectRevert("vetoed");
        governor.execute(pid);
    }

    function testExpiryBlocksExecution() public {
        bytes32 pid = _proposeSetValue(42);
        vm.warp(block.timestamp + 8 days);
        vm.expectRevert("proposal expired");
        governor.vote(pid, C0);
    }

    function testBoundVoterEnforced() public {
        address voter0 = makeAddr("voter0");
        governor.setConnectomeVoter(C0, voter0);
        bytes32 pid = _proposeSetValue(42);
        engine.setDecision(C0, 1, 80);
        vm.expectRevert("not connectome voter");
        governor.vote(pid, C0);
        vm.prank(voter0);
        governor.vote(pid, C0);
        assertTrue(governor.hasVoted(pid, C0));
    }

    function testConfidenceWeighting() public {
        governor.setConfidenceWeightedVoting(true);
        governor.setWeightThreshold(200);
        bytes32 pid = _proposeSetValue(42);
        engine.setDecision(C0, 1, 60); // weight 60
        engine.setDecision(C1, 1, 60);
        engine.setDecision(C2, 1, 60); // total 180 < 200
        governor.vote(pid, C0);
        governor.vote(pid, C1);
        governor.vote(pid, C2);
        assertFalse(governor.isPassed(pid)); // count quorum met but weight < 200
    }
}

// ==================== GOVERNOR POLICY / TREASURY PATH TESTS ====================

contract GovernorPolicyTest is Test {
    Kernel kernel;
    OlympusTreasury trsry;
    GovernorPolicy policy;
    ERC20Mock reserve;
    address governor = makeAddr("governor");
    address safe = makeAddr("safe");

    function setUp() public {
        kernel = new Kernel();
        trsry = new OlympusTreasury(kernel);
        kernel.executeAction(Actions.InstallModule, address(trsry));
        policy = new GovernorPolicy(kernel);
        kernel.executeAction(Actions.ActivatePolicy, address(policy));
        policy.setGovernor(governor);
        reserve = new ERC20Mock("USDC", "USDC", 6);
    }

    function testGovernorCanWithdrawReserves() public {
        // Fund TRSRY directly (module is the vault)
        reserve.mint(address(trsry), 1000e6);
        // Olympus flow: governor first grants the policy a withdrawal approval,
        // then withdraws within it.
        vm.startPrank(governor);
        policy.executeModule(
            address(trsry),
            abi.encodeWithSelector(
                bytes4(keccak256("increaseWithdrawApproval(address,address,uint256)")),
                address(policy), address(reserve), 500e6
            )
        );
        policy.trsryWithdrawReserves(safe, address(reserve), 500e6);
        vm.stopPrank();
        assertEq(reserve.balanceOf(safe), 500e6);
    }

    function testExecuteModuleGeneric() public {
        reserve.mint(address(trsry), 1000e6);
        vm.startPrank(governor);
        policy.executeModule(
            address(trsry),
            abi.encodeWithSelector(
                bytes4(keccak256("increaseWithdrawApproval(address,address,uint256)")),
                address(policy), address(reserve), 250e6
            )
        );
        policy.executeModule(
            address(trsry),
            abi.encodeWithSelector(
                bytes4(keccak256("withdrawReserves(address,address,uint256)")),
                safe, address(reserve), 250e6
            )
        );
        vm.stopPrank();
        assertEq(reserve.balanceOf(safe), 250e6);
    }

    function testApproveTokenForBuybackFloat() public {
        reserve.mint(address(policy), 100e6);
        vm.prank(governor);
        policy.approveToken(address(reserve), safe, 50e6);
        assertEq(reserve.allowance(address(policy), safe), 50e6);
    }

    function testNonGovernorCannotCall() public {
        vm.prank(safe);
        vm.expectRevert("not governor");
        policy.trsryWithdrawReserves(safe, address(reserve), 1);
    }
}

// ==================== DEPLOYMENT FLOW TESTS ====================

contract DeploymentFlowTest is Test {
    SymbientToken public symbientToken;
    Kernel public kernel;
    TreasuryValuation public treasuryPolicy;
    address public safe = makeAddr("safe");
    address public deployer = vm.addr(0xA11CE);

    function setUp() public {
        vm.startPrank(deployer);
        symbientToken = new SymbientToken(safe);
        kernel = new Kernel();
        kernel.executeAction(Actions.ChangeExecutor, safe);
        treasuryPolicy = new TreasuryValuation(safe);
        vm.stopPrank();
    }

    function testAllContractsDeployed() public view {
        assertTrue(address(symbientToken) != address(0));
        assertTrue(address(kernel) != address(0));
        assertTrue(address(treasuryPolicy) != address(0));
    }

    function testSafeCanMintSymbient() public {
        vm.prank(safe);
        symbientToken.mint(deployer, 1000e18);
        assertEq(symbientToken.balanceOf(deployer), 1000e18);
    }

    function testDeployerCannotMint() public {
        vm.prank(deployer);
        vm.expectRevert();
        symbientToken.mint(deployer, 1000e18);
    }

    function testMaxSupplyEnforced() public {
        vm.prank(safe);
        symbientToken.mint(deployer, 100_000_000e18);
        vm.prank(safe);
        vm.expectRevert(SymbientToken.MaxSupplyExceeded.selector);
        symbientToken.mint(deployer, 1);
    }
}

// ==================== EXTERNAL TOKEN (Tolly-launch) TESTS ====================

/// @notice SYM as an externally launched fixed-supply token: no protocol mint,
///         no burn. Staking rewards must be funded via depositRewards, and the
///         inverse bond sinks bought-back tokens to the dead address.
contract ExternalTokenTest is Test {
    FixedSupplyToken symbient; // behaves like a Tolly-launched SYM
    SymbientStaking staking;
    SymbientInverseBond inverseBond;
    CBMockTreasuryPolicy valuation;
    ERC20Mock payoutToken;
    address multisig = makeAddr("multisig");
    address treasury = makeAddr("treasury");
    address admin = makeAddr("admin");

    function setUp() public {
        // 100M fixed supply — mimics a launch where the entire supply exists day one
        symbient = new FixedSupplyToken("SYM", "SYM", 100_000_000e18);
        staking = new SymbientStaking(address(symbient), address(new TestPriceFeed()), address(new TestTreasuryPolicy()), multisig);
        payoutToken = new ERC20Mock("USDC", "USDC", 6);
        valuation = new CBMockTreasuryPolicy();
        inverseBond = new SymbientInverseBond(address(symbient), address(payoutToken), treasury, address(valuation), admin);
    }

    function testStakeAndUnstakeExternalToken() public {
        symbient.approve(address(staking), 100e18);
        uint256 st = staking.stake(100e18);
        assertEq(st, 100e18);
        assertEq(staking.unstake(50e18), 50e18);
    }

    function testRebaseFundedByRewardPool() public {
        // stake 100, deposit 10 into rewardPool, rebase → index rises, unstaker
        // receives real (pre-funded) tokens — no mint possible on external token
        symbient.approve(address(staking), 100e18);
        staking.stake(100e18);

        symbient.approve(address(staking), 10e18);
        staking.depositRewards(10e18);
        assertEq(staking.rewardPool(), 10e18);
        // Pool must not count toward index before distribution
        assertEq(staking.index(), 1e18);

        vm.warp(block.timestamp + 8 hours + 1);
        staking.rebase();

        // index = (contractBalance excl. pool) + funded rewards over stSYM supply.
        // contractBalance excl. pool = 100; rewards drawn up to target = 10.
        assertGt(staking.index(), 1e18);
        uint256 out = staking.unstake(100e18);
        assertEq(out, 110e18); // 100 staked + 10 rewards, all real tokens
        assertEq(symbient.balanceOf(address(staking)), 0);
    }

    function testRebaseWithoutFundingDoesNotInflateIndex() public {
        // No rewardPool and no mint → index must NOT rise beyond real balance
        symbient.approve(address(staking), 100e18);
        staking.stake(100e18);
        vm.warp(block.timestamp + 8 hours + 1);
        staking.rebase();
        // price feed returns NAV = TWAP = 1e18 → no premium → no supplemental
        assertEq(staking.index(), 1e18);
        assertEq(staking.unstake(100e18), 100e18);
    }

    function testInverseBondSinksToDeadAddress() public {
        valuation.setFloorPrice(2e6);
        valuation.setRfv(1_000_000e6);
        symbient.transfer(makeAddr("seller"), 100e18);
        payoutToken.mint(treasury, 100000e6);
        vm.prank(treasury);
        payoutToken.approve(address(inverseBond), type(uint256).max);

        address seller = makeAddr("seller");
        vm.startPrank(seller);
        symbient.approve(address(inverseBond), 100e18);
        uint256 payout = inverseBond.sell(100e18);
        vm.stopPrank();

        assertEq(payout, (100e18 * ((2e6 * 9850) / 10000)) / 1e18);
        // Non-burnable token → routed to dead sink, not stuck in bond
        assertEq(symbient.balanceOf(inverseBond.DEAD_ADDRESS()), 100e18);
        assertEq(symbient.balanceOf(address(inverseBond)), 0);
    }
}

/// @notice Minimal UniV2 router mock — swaps at a fixed rate (1 USDC : 100 SYM)
///         out of pre-funded inventory (real routers pay from pool reserves).
contract MockV2Router {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256,
        address[] calldata path,
        address to,
        uint256
    ) external returns (uint256[] memory amounts) {
        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);
        uint256 out = amountIn * 100 * 1e12; // 6-dec in → 18-dec out × 100
        IERC20(path[1]).transfer(to, out);
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = out;
    }
}

// ==================== FEE ROUTER (Tolly LP fees → staker rewards) ============

contract SymbientFeeRouterTest is Test {
    FixedSupplyToken symbient;
    ERC20Mock usdc;
    MockV2Router router;
    SymbientStaking staking;
    SymbientFeeRouter feeRouter;
    address admin = makeAddr("admin");
    address keeper = makeAddr("keeper");
    address governor = makeAddr("governor"); // stands in for GovernorPolicy
    address treasury = makeAddr("treasury"); // TRSRY — the single treasury

    function setUp() public {
        symbient = new FixedSupplyToken("SYM", "SYM", 100_000_000e18);
        usdc = new ERC20Mock("USDC", "USDC", 6);
        router = new MockV2Router();
        staking = new SymbientStaking(address(symbient), address(new TestPriceFeed()), address(new TestTreasuryPolicy()), admin);
        feeRouter = new SymbientFeeRouter(
            address(usdc), address(symbient), address(router), address(staking), address(0), treasury, admin
        );
        // LP inventory on the router mock (Tolly pool reserves)
        symbient.transfer(address(router), 10_000_000e18);
        bytes32 keeperRole = feeRouter.KEEPER_ROLE();
        bytes32 govRole = feeRouter.GOVERNANCE_ROLE();
        vm.startPrank(admin);
        feeRouter.grantRole(keeperRole, keeper);
        feeRouter.grantRole(govRole, governor); // GovernorPolicy in production
        vm.stopPrank();
    }

    function testRouteToTreasuryConsolidatesFunds() public {
        // claimed creator fees consolidate into the single treasury (TRSRY)
        usdc.mint(address(feeRouter), 1000e6);
        feeRouter.routeToTreasury();
        assertEq(usdc.balanceOf(treasury), 1000e6);
        assertEq(usdc.balanceOf(address(feeRouter)), 0);
        // nothing reaches the reward pool — connectomes haven't decided yet
        assertEq(staking.rewardPool(), 0);
    }

    function testFundRewardsRequiresGovernance() public {
        usdc.mint(address(feeRouter), 1000e6);
        // keeper cannot fund rewards — this is a connectome decision
        vm.prank(keeper);
        vm.expectRevert();
        feeRouter.fundRewards(1000e6, 0);
        // permissionless caller also blocked
        vm.expectRevert();
        feeRouter.fundRewards(1000e6, 0);
    }

    function testGovernanceFundsRewards() public {
        usdc.mint(address(feeRouter), 1000e6);
        vm.prank(governor);
        feeRouter.fundRewards(1000e6, 0);
        // 1000 USDC → 100_000 SYM into the reward pool
        assertEq(staking.rewardPool(), 100_000e18);
        assertEq(usdc.balanceOf(address(feeRouter)), 0);
        assertEq(symbient.balanceOf(address(feeRouter)), 0);
    }

    function testFundRewardsPartialAmount() public {
        usdc.mint(address(feeRouter), 1000e6);
        vm.prank(governor);
        feeRouter.fundRewards(400e6, 0); // connectomes choose the size
        assertEq(staking.rewardPool(), 40_000e18);
        assertEq(usdc.balanceOf(address(feeRouter)), 600e6); // rest still tradeable
    }

    function testFullLoopTradeThenReward() public {
        // stake first
        symbient.transfer(address(this), 100e18);
        symbient.approve(address(staking), 100e18);
        staking.stake(100e18);

        // fees claimed → consolidated into the single treasury
        usdc.mint(address(feeRouter), 10e6);
        feeRouter.routeToTreasury();
        assertEq(usdc.balanceOf(treasury), 10e6);

        // ...connectomes trade a TRSRY-funded float here (adapter buy/sell;
        // sell proceeds return to TRSRY). A governance withdrawal can return
        // USDC to the router for reward funding.
        vm.prank(treasury);
        usdc.transfer(address(feeRouter), 10e6);

        // connectomes vote to fund staker rewards
        vm.prank(governor);
        feeRouter.fundRewards(10e6, 0); // → 1000 SYM into rewardPool

        vm.warp(block.timestamp + 8 hours + 1);
        staking.rebase();
        assertGt(staking.index(), 1e18);
        assertEq(staking.unstake(100e18), 1100e18); // 100 staked + 1000 rewards
    }
}

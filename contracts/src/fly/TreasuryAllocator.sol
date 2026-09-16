// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title TreasuryAllocator — Multi-strategy treasury with Yearn-style IStrategy pattern
/// @notice Treasury funds are allocated across strategies. Connectomes vote on
///         allocation changes (infrequent). Strategies execute autonomously within bounds.
/// @dev Each strategy implements IStrategy. Allocator manages deposits/withdrawals.
interface IStrategy {
    function name() external view returns (string memory);
    function deposit(uint256 amount) external;
    function withdraw(uint256 amount) external;
    function balance() external view returns (uint256);
    function harvest() external returns (uint256);
}

contract TreasuryAllocator is ReentrancyGuard, AccessControl {
    using SafeERC20 for IERC20;

    IERC20 public immutable reserveToken;

    struct StrategyConfig {
        IStrategy strategy;
        bool active;
        uint256 maxAllocation;  // max reserve tokens allocatable to this strategy
        uint256 currentAllocation;
        uint256 lastHarvest;
        uint256 totalHarvested;
    }

    mapping(bytes32 => StrategyConfig) public strategies;
    bytes32[] public strategyIds;

    // Target allocation set by governance (infrequent votes)
    // Each strategy gets a percentage of total treasury (in BPS)
    mapping(bytes32 => uint256) public targetAllocationBps;
    uint256 public constant BPS_DENOM = 10000;
    uint256 public rebalanceThreshold = 500; // 5% deviation triggers rebalance

    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    event StrategyRegistered(bytes32 indexed id, string name, uint256 maxAllocation);
    event StrategyRemoved(bytes32 indexed id);
    event Allocated(bytes32 indexed id, uint256 amount);
    event Withdrawn(bytes32 indexed id, uint256 amount);
    event Harvested(bytes32 indexed id, uint256 amount);
    event TargetAllocationSet(bytes32 indexed id, uint256 bps);
    event RebalanceThresholdUpdated(uint256 newThreshold);

    constructor(address _reserveToken, address _admin) {
        reserveToken = IERC20(_reserveToken);
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(GOVERNANCE_ROLE, _admin);
        _grantRole(KEEPER_ROLE, _admin);
    }

    // ============ Governance (infrequent) ============

    /// @notice Register a new strategy — GOVERNANCE VOTE REQUIRED
    function registerStrategy(
        bytes32 id,
        address strategy,
        uint256 maxAllocation,
        uint256 targetBps
    ) external onlyRole(GOVERNANCE_ROLE) {
        require(address(strategies[id].strategy) == address(0), "strategy exists");
        strategies[id] = StrategyConfig({
            strategy: IStrategy(strategy),
            active: true,
            maxAllocation: maxAllocation,
            currentAllocation: 0,
            lastHarvest: block.timestamp,
            totalHarvested: 0
        });
        strategyIds.push(id);
        targetAllocationBps[id] = targetBps;
        emit StrategyRegistered(id, IStrategy(strategy).name(), maxAllocation);
        emit TargetAllocationSet(id, targetBps);
    }

    /// @notice Set target allocation for a strategy — GOVERNANCE VOTE REQUIRED
    function setTargetAllocation(bytes32 id, uint256 bps) external onlyRole(GOVERNANCE_ROLE) {
        require(bps <= BPS_DENOM, "exceeds 100%");
        targetAllocationBps[id] = bps;
        emit TargetAllocationSet(id, bps);
    }

    /// @notice Remove a strategy (withdraws all funds first) — GOVERNANCE VOTE REQUIRED
    function removeStrategy(bytes32 id) external onlyRole(GOVERNANCE_ROLE) nonReentrant {
        StrategyConfig storage s = strategies[id];
        require(s.active, "not active");
        if (s.currentAllocation > 0) {
            s.strategy.withdraw(s.currentAllocation);
            s.currentAllocation = 0;
        }
        s.active = false;
        emit StrategyRemoved(id);
    }

    function setRebalanceThreshold(uint256 threshold) external onlyRole(GOVERNANCE_ROLE) {
        rebalanceThreshold = threshold;
        emit RebalanceThresholdUpdated(threshold);
    }

    // ============ Autonomous Operations (keeper, no governance vote) ============

    /// @notice Rebalance treasury across strategies — KEEPER calls, no governance vote
    /// @dev Moves funds to match target allocations. Only runs if deviation > threshold.
    function rebalance() external onlyRole(KEEPER_ROLE) nonReentrant {
        uint256 totalBalance = reserveToken.balanceOf(address(this));
        for (uint256 i = 0; i < strategyIds.length; i++) {
            bytes32 id = strategyIds[i];
            StrategyConfig storage s = strategies[id];
            if (!s.active) continue;

            uint256 target = (totalBalance * targetAllocationBps[id]) / BPS_DENOM;
            uint256 current = s.currentAllocation;
            uint256 deviation = current > target ? current - target : target - current;

            if (deviation * BPS_DENOM / (totalBalance + 1) < rebalanceThreshold) continue;

            if (current < target) {
                // Deposit more
                uint256 toDeposit = target - current;
                if (toDeposit > s.maxAllocation - current) toDeposit = s.maxAllocation - current;
                if (toDeposit > 0 && reserveToken.balanceOf(address(this)) >= toDeposit) {
                    reserveToken.safeIncreaseAllowance(address(s.strategy), toDeposit);
                    s.strategy.deposit(toDeposit);
                    s.currentAllocation += toDeposit;
                    emit Allocated(id, toDeposit);
                }
            } else if (current > target) {
                // Withdraw excess
                uint256 toWithdraw = current - target;
                s.strategy.withdraw(toWithdraw);
                s.currentAllocation -= toWithdraw;
                emit Withdrawn(id, toWithdraw);
            }
        }
    }

    /// @notice Harvest yield from all strategies — KEEPER calls, no governance vote
    function harvestAll() external onlyRole(KEEPER_ROLE) nonReentrant {
        for (uint256 i = 0; i < strategyIds.length; i++) {
            bytes32 id = strategyIds[i];
            StrategyConfig storage s = strategies[id];
            if (!s.active) continue;
            uint256 yield = s.strategy.harvest();
            if (yield > 0) {
                s.totalHarvested += yield;
                s.lastHarvest = block.timestamp;
                emit Harvested(id, yield);
            }
        }
    }

    // ============ View ============

    function getStrategyCount() external view returns (uint256) {
        return strategyIds.length;
    }

    function getStrategyInfo(bytes32 id) external view returns (
        string memory name,
        bool active,
        uint256 maxAllocation,
        uint256 currentAllocation,
        uint256 totalHarvested,
        uint256 targetBps
    ) {
        StrategyConfig storage s = strategies[id];
        return (
            s.strategy.name(),
            s.active,
            s.maxAllocation,
            s.currentAllocation,
            s.totalHarvested,
            targetAllocationBps[id]
        );
    }

    function getTotalAllocated() external view returns (uint256) {
        uint256 total = 0;
        for (uint256 i = 0; i < strategyIds.length; i++) {
            total += strategies[strategyIds[i]].currentAllocation;
        }
        return total;
    }
}

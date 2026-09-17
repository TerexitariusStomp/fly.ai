// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Kernel, Policy, Keycode, toKeycode, Permissions} from "@olympus-v3/Kernel.sol";
import {ROLESv1} from "@olympus-v3/modules/ROLES/ROLES.v1.sol";
import {IPeriodicTask} from "@olympus-v3/interfaces/IPeriodicTask.sol";
import {IERC165} from "@openzeppelin-4.8.0/interfaces/IERC165.sol";
import {IOperator} from "@olympus-v3/policies/interfaces/IOperator.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {SymbientCircuitBreaker} from "./SymbientCircuitBreaker.sol";

/// @title SymbientDefenseBudget
/// @notice Per-epoch treasury defense budget for RBS wall operations
/// @dev The Olympus V3 Operator has capacity + regen, but no hard cap on total
///      treasury drawdown per epoch/day. Under sustained one-directional pressure,
///      the treasury could keep defending the wall until reserves are meaningfully
///      drawn down (Frax AMO lesson).
///
///      This contract is a Kernel Policy that implements IPeriodicTask.
///      It is registered as a periodic task on the Heart, which calls execute()
///      on each beat. execute() calls IOperator.operate() with budget enforcement.
///
///      Design:
///      - Tracks SYM token outflows from treasury during wall defense
///      - Per-epoch budget (default: 2% of liquid treasury value)
///      - When budget exhausted, blocks further operate() calls until next epoch
///      - Multisig can adjust budget or emergency override
contract SymbientDefenseBudget is Policy, IPeriodicTask, AccessControl {
    bytes32 public constant MULTISIG_ROLE = keccak256("MULTISIG_ROLE");
    error ZeroAddress();

    error BudgetExhausted();
    error InvalidParams();
    error OperatorNotSet();
    error CircuitBreakerTripped();

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant EPOCH_LENGTH = 8 hours;

    IOperator public operator; // Olympus V3 Operator
    address public treasury; // Treasury address (SYM source for defense)
    address public symbientToken;

    uint256 public budgetBps = 200; // 2% of liquid treasury per epoch
    uint256 public epochStart;
    uint256 public epochSpent;
    uint256 public liquidTreasuryValue; // Updated by multisig

    bool public budgetOverride; // Multisig can disable budget enforcement

    // Circuit breaker integration — defense spending halts if SYM spot breaks floor
    SymbientCircuitBreaker public circuitBreaker;

    ROLESv1 internal ROLES;

    event BudgetUpdated(uint256 indexed bps);
    event EpochReset(uint256 indexed epochStart, uint256 indexed carriedOver);
    event SpendingRecorded(uint256 indexed amount, uint256 indexed totalThisEpoch);
    event BudgetExhaustedEvent(uint256 indexed spent, uint256 indexed budget);
    event OverrideToggled(bool indexed override_);
    event OperatorUpdated(address indexed operator);
    event CircuitBreakerSet(address indexed breaker);

    constructor(
        Kernel kernel_,
        address _operator,
        address _treasury,
        address _symbientToken,
        address _multisig
    ) Policy(kernel_) AccessControl() {
        _grantRole(DEFAULT_ADMIN_ROLE, _multisig);
        _grantRole(MULTISIG_ROLE, _multisig);
        if (_treasury == address(0) || _symbientToken == address(0) || _multisig == address(0))
            revert ZeroAddress();
        if (_operator != address(0)) {
            operator = IOperator(_operator);
        }
        treasury = _treasury;
        symbientToken = _symbientToken;
        epochStart = block.timestamp;
    }

    /// @inheritdoc Policy
    function configureDependencies() external override returns (Keycode[] memory dependencies) {
        dependencies = new Keycode[](1);
        dependencies[0] = toKeycode("ROLES");
        ROLES = ROLESv1(getModuleAddress(dependencies[0]));
    }

    /// @inheritdoc Policy
    function requestPermissions() external view override returns (Permissions[] memory requests) {
        requests = new Permissions[](0);
    }

    /// @notice Returns the contract version
    function VERSION() external pure returns (uint8 major, uint8 minor) {
        return (1, 0);
    }

    //============================================================================================//
    //                                   IPeriodicTask                                             //
    //============================================================================================//

    /// @inheritdoc IPeriodicTask
    /// @dev Called by the Heart on each beat. Wraps Operator.operate() with budget enforcement.
    ///      Reverts if budget exhausted (which causes the entire beat to revert — this is intentional,
    ///      as the Heart's _executePeriodicTasks expects tasks to revert loudly).
    ///      Use budgetOverride to allow operate() to run without budget checks in emergencies.
    function execute() external override {
        _resetEpochIfNeeded();

        if (address(operator) == address(0)) revert OperatorNotSet();

        // Halt defense spending if circuit breaker is tripped (SYM below floor)
        if (address(circuitBreaker) != address(0) && circuitBreaker.paused())
            revert CircuitBreakerTripped();

        if (!budgetOverride && epochSpent >= currentBudget()) {
            emit BudgetExhaustedEvent(epochSpent, currentBudget());
            revert BudgetExhausted();
        }

        // Measure treasury outflow before and after
        uint256 balanceBefore = IERC20(symbientToken).balanceOf(treasury);

        // Call Operator.operate() — this contract has the "heart" role granted by RolesAdmin
        operator.operate();

        uint256 balanceAfter = IERC20(symbientToken).balanceOf(treasury);
        if (balanceBefore > balanceAfter) {
            epochSpent += (balanceBefore - balanceAfter);
            emit SpendingRecorded(balanceBefore - balanceAfter, epochSpent);
        }
    }

    /// @notice Checks if the contract supports an interface
    function supportsInterface(bytes4 interfaceId) public view override(AccessControl, IPeriodicTask) returns (bool) {
        return AccessControl.supportsInterface(interfaceId)
            || interfaceId == type(IPeriodicTask).interfaceId;
    }

    //============================================================================================//
    //                                   ADMIN FUNCTIONS                                           //
    //============================================================================================//

    function setOperator(address _operator) external onlyRole(MULTISIG_ROLE) {
        if (_operator == address(0)) revert ZeroAddress();
        operator = IOperator(_operator);
        emit OperatorUpdated(_operator);
    }

    /// @notice Update liquid treasury value (multisig only)
    function updateLiquidTreasuryValue(uint256 _value) external onlyRole(MULTISIG_ROLE) {
        liquidTreasuryValue = _value;
    }

    /// @notice Set per-epoch budget in bps of liquid treasury
    function setBudgetBps(uint256 _bps) external onlyRole(MULTISIG_ROLE) {
        if (_bps > 5000) revert InvalidParams(); // Max 50% per epoch
        budgetBps = _bps;
        emit BudgetUpdated(_bps);
    }

    /// @notice Toggle budget enforcement (emergency override)
    function setOverride(bool _override) external onlyRole(MULTISIG_ROLE) {
        budgetOverride = _override;
        emit OverrideToggled(_override);
    }

    function setCircuitBreaker(address _breaker) external onlyRole(MULTISIG_ROLE) {
        circuitBreaker = SymbientCircuitBreaker(_breaker);
        emit CircuitBreakerSet(_breaker);
    }

    /// @notice Record spending from treasury defense (manual accounting)
    function recordSpending(uint256 amount) external onlyRole(MULTISIG_ROLE) {
        _resetEpochIfNeeded();
        epochSpent += amount;
        emit SpendingRecorded(amount, epochSpent);
    }

    //============================================================================================//
    //                                   VIEW FUNCTIONS                                            //
    //============================================================================================//

    /// @notice Current epoch spending budget
    function currentBudget() public view returns (uint256) {
        return (liquidTreasuryValue * budgetBps) / BPS_DENOMINATOR;
    }

    /// @notice Check if budget allows spending
    function budgetAvailable() public view returns (bool) {
        if (budgetOverride) return true;
        uint256 effectiveSpent = (block.timestamp >= epochStart + EPOCH_LENGTH) ? 0 : epochSpent;
        return effectiveSpent < currentBudget();
    }

    function _resetEpochIfNeeded() internal {
        if (block.timestamp >= epochStart + EPOCH_LENGTH) {
            epochStart = block.timestamp;
            epochSpent = 0;
            emit EpochReset(epochStart, 0);
        }
    }
}

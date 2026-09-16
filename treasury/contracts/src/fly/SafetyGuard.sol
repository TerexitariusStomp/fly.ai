// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title SafetyGuard — on-chain enforcement layer for autonomous connectome agents
/// @notice Layer 6 of the defense-in-depth architecture. Even if the canister
///         or LLM is fully compromised, the contract rejects anything outside
///         the allowlists: tokens, target contracts, per-connectome daily
///         spend caps, per-connectome pause, and a drawdown circuit breaker.
contract SafetyGuard is AccessControl, Pausable {
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    /// @dev Only these tokens may be traded/moved by connectomes
    mapping(address => bool) public allowedTokens;
    /// @dev Only these contracts may be called by connectomes
    mapping(address => bool) public allowedContracts;
    /// @dev Per-connectome daily spending limit (in reserve units)
    mapping(bytes32 => uint256) public dailyLimit;
    /// @dev Per-connectome amount spent in the current day window
    mapping(bytes32 => uint256) public dailySpent;
    /// @dev Day window anchor — spends roll over every 24h
    mapping(bytes32 => uint256) public dayStart;
    /// @dev Per-connectome pause switch
    mapping(bytes32 => bool) public connectomePaused;
    /// @dev Circuit breaker: max drawdown before auto-pause (bps)
    uint256 public maxDrawdownBps = 2000; // 20%

    event AllowedTokenUpdated(address indexed token, bool allowed);
    event AllowedContractUpdated(address indexed target, bool allowed);
    event DailyLimitUpdated(bytes32 indexed connectomeId, uint256 limit);
    event ConnectomePausedSet(bytes32 indexed connectomeId, bool paused);
    event CircuitBreakerTripped(bytes32 indexed connectomeId, uint256 drawdownBps);
    event SpendRecorded(bytes32 indexed connectomeId, uint256 amount, uint256 dayTotal);

    error TokenNotAllowed(address token);
    error ContractNotAllowed(address target);
    error ConnectomeIsPaused(bytes32 connectomeId);
    error DailyLimitExceeded(bytes32 connectomeId, uint256 attempted, uint256 limit);

    constructor(address _admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(GUARDIAN_ROLE, _admin);
    }

    /// @notice Revert if any enforcement check fails. Callers (governor /
    ///         adapters) invoke this before executing a connectome action.
    function enforceAction(bytes32 connectomeId, address target, address token, uint256 amount) external {
        if (paused() || connectomePaused[connectomeId]) revert ConnectomeIsPaused(connectomeId);
        if (!allowedContracts[target]) revert ContractNotAllowed(target);
        if (token != address(0) && !allowedTokens[token]) revert TokenNotAllowed(token);
        if (amount > 0) _recordSpend(connectomeId, amount);
    }

    function _recordSpend(bytes32 connectomeId, uint256 amount) internal {
        if (block.timestamp >= dayStart[connectomeId] + 1 days) {
            dayStart[connectomeId] = block.timestamp;
            dailySpent[connectomeId] = 0;
        }
        uint256 limit = dailyLimit[connectomeId];
        if (limit > 0 && dailySpent[connectomeId] + amount > limit) {
            revert DailyLimitExceeded(connectomeId, dailySpent[connectomeId] + amount, limit);
        }
        dailySpent[connectomeId] += amount;
        emit SpendRecorded(connectomeId, amount, dailySpent[connectomeId]);
    }

    // ============ Admin / guardian ============

    function setAllowedToken(address token, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        allowedTokens[token] = allowed;
        emit AllowedTokenUpdated(token, allowed);
    }

    function setAllowedContract(address target, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        allowedContracts[target] = allowed;
        emit AllowedContractUpdated(target, allowed);
    }

    function setDailyLimit(bytes32 connectomeId, uint256 limit) external onlyRole(DEFAULT_ADMIN_ROLE) {
        dailyLimit[connectomeId] = limit;
        emit DailyLimitUpdated(connectomeId, limit);
    }

    function setMaxDrawdownBps(uint256 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        maxDrawdownBps = bps;
    }

    /// @notice Anyone can trip the breaker — drawdown data is the caller's
    ///         responsibility; a false trip is recovered by unpause.
    function checkCircuitBreaker(bytes32 connectomeId, uint256 currentDrawdownBps) external {
        if (currentDrawdownBps > maxDrawdownBps && !connectomePaused[connectomeId]) {
            connectomePaused[connectomeId] = true;
            emit CircuitBreakerTripped(connectomeId, currentDrawdownBps);
            emit ConnectomePausedSet(connectomeId, true);
        }
    }

    function pauseConnectome(bytes32 connectomeId) external onlyRole(GUARDIAN_ROLE) {
        connectomePaused[connectomeId] = true;
        emit ConnectomePausedSet(connectomeId, true);
    }

    function unpauseConnectome(bytes32 connectomeId) external onlyRole(GUARDIAN_ROLE) {
        connectomePaused[connectomeId] = false;
        emit ConnectomePausedSet(connectomeId, false);
    }

    function pauseAll() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    function unpauseAll() external onlyRole(GUARDIAN_ROLE) {
        _unpause();
    }
}

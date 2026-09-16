// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title PerformanceBridge — On-chain performance tracking for connectomes
/// @notice Thin bridge to DeFi Arena Leaderboard + PortfolioManager (already vendored).
///         All PnL logic is in DeFi Arena — this contract just records trades and reads results.
///         Surpasses all competitors: no one else tracks biological neural trading PnL on-chain.
interface IPortfolioManager {
    function recordTrade(bytes32 agentId, int256 pnl, uint256 timestamp) external;
    function getAgentPnl(bytes32 agentId) external view returns (int256);
    function getAgentTrades(bytes32 agentId) external view returns (uint256);
}

interface ILeaderboard {
    function getTopAgents(uint256 limit) external view returns (bytes32[] memory, int256[] memory);
    function getRank(bytes32 agentId) external view returns (uint256);
}

contract PerformanceBridge is AccessControl {
    IPortfolioManager public portfolioManager;
    ILeaderboard public leaderboard;

    // Per-connectome stats (mirrored for quick access)
    struct Performance {
        int256 totalPnl;
        uint256 totalTrades;
        uint256 wins;
        uint256 losses;
        uint256 lastTradeTime;
    }
    mapping(bytes32 => Performance) public performances;

    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    event TradeRecorded(
        bytes32 indexed connectomeId,
        address indexed token,
        int8 action,       // 1=buy, -1=sell, 0=hold
        uint256 amount,
        int256 pnl,
        uint256 timestamp
    );

    constructor(address _portfolioManager, address _leaderboard, address _admin) {
        portfolioManager = IPortfolioManager(_portfolioManager);
        leaderboard = ILeaderboard(_leaderboard);
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(KEEPER_ROLE, _admin);
    }

    /// @notice Record a trade executed by a connectome — KEEPER calls, no governance vote
    function recordTrade(
        bytes32 connectomeId,
        address token,
        int8 action,
        uint256 amount,
        int256 pnl
    ) external onlyRole(KEEPER_ROLE) {
        Performance storage p = performances[connectomeId];
        p.totalPnl += pnl;
        p.totalTrades++;
        if (pnl > 0) p.wins++;
        else if (pnl < 0) p.losses++;
        p.lastTradeTime = block.timestamp;

        // Record in DeFi Arena PortfolioManager (all PnL logic is there)
        portfolioManager.recordTrade(connectomeId, pnl, block.timestamp);

        emit TradeRecorded(connectomeId, token, action, amount, pnl, block.timestamp);
    }

    // ============ View Functions ============

    function getPerformance(bytes32 connectomeId) external view returns (
        int256 totalPnl,
        uint256 totalTrades,
        uint256 wins,
        uint256 losses,
        uint256 winRate
    ) {
        Performance storage p = performances[connectomeId];
        uint256 rate = p.totalTrades > 0 ? (p.wins * 10000) / p.totalTrades : 0;
        return (p.totalPnl, p.totalTrades, p.wins, p.losses, rate);
    }

    function getLeaderboard(uint256 limit) external view returns (bytes32[] memory, int256[] memory) {
        return leaderboard.getTopAgents(limit);
    }

    function getRank(bytes32 connectomeId) external view returns (uint256) {
        return leaderboard.getRank(connectomeId);
    }

    function getPnl(bytes32 connectomeId) external view returns (int256) {
        return performances[connectomeId].totalPnl;
    }
}

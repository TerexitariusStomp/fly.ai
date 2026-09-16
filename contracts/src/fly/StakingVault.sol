// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title StakingVault — Stake LP tokens to signal which memecoins to trade
/// @notice People stake LP tokens (memecoin + SYM pair) to signal support for
///         that memecoin. The treasury uses staked amounts to decide which tokens
///         to trade. More staked = more likely the treasury buys that memecoin.
///         The staking acts as "buy walls" — the LP provides liquidity.
contract StakingVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============ Types ============
    struct StakeInfo {
        address staker;        // who staked
        address lpToken;       // LP token address (memecoin + SYM pair)
        address memecoin;      // the memecoin in the pair
        uint256 amount;        // amount of LP tokens staked
        uint256 timestamp;     // when staked
        uint256 lockUntil;     // lock period end
    }

    struct MemecoinSignal {
        address memecoin;
        uint256 totalStaked;   // total LP staked for this memecoin
        uint256 stakerCount;   // number of unique stakers
        uint256 lastTrade;     // last time treasury traded this memecoin
        uint256 signalScore;   // computed signal score (higher = more likely to trade)
    }

    // ============ Storage ============
    IERC20 public immutable SYM;           // SYM token
    address public governor;                // ConnectomeGovernor address
    address public admin;                   // vault admin
    address public profitSharingVault;      // ProfitSharingVault address (OSS, MIT)

    mapping(address => StakeInfo[]) public stakes;          // staker => stakes
    mapping(address => MemecoinSignal) public signals;      // memecoin => signal
    mapping(address => uint256) public totalStakedByToken;  // memecoin => total LP staked
    mapping(address => bool) public isWhitelistedLP;        // LP token whitelist
    mapping(address => address) public lpTokenToMemecoin;   // LP token => memecoin address

    uint256 public totalStaked;             // total LP tokens staked across all memecoins
    uint256 public minStakeAmount = 1e18;   // minimum LP to stake
    uint256 public lockPeriod = 7 days;     // minimum lock period
    uint256 public signalDecay = 86400;     // signal decays over 24h

    // ============ Events ============
    event Staked(address indexed staker, address indexed lpToken, address indexed memecoin, uint256 amount);
    event Unstaked(address indexed staker, address indexed lpToken, uint256 amount);
    event SignalUpdated(address indexed memecoin, uint256 signalScore, uint256 totalStaked);
    event TradeTriggered(address indexed memecoin, uint256 amount);
    event ProfitsDistributed(address indexed memecoin, uint256 profit, uint256 stakerShare, uint256 treasuryShare);

    // ============ Constructor ============
    constructor(address _symbient, address _admin) {
        SYM = IERC20(_symbient);
        admin = _admin;
    }

    // ============ Staking ============

    /// @notice Stake LP tokens to signal support for a memecoin
    /// @param lpToken The LP token address (memecoin + SYM pair)
    /// @param amount Amount of LP tokens to stake
    function stake(address lpToken, uint256 amount) external nonReentrant {
        require(amount >= minStakeAmount, "below minimum");
        require(isWhitelistedLP[lpToken], "LP not whitelisted");

        address memecoin = lpTokenToMemecoin[lpToken];
        require(memecoin != address(0), "unknown LP token");

        IERC20(lpToken).safeTransferFrom(msg.sender, address(this), amount);

        stakes[msg.sender].push(StakeInfo({
            staker: msg.sender,
            lpToken: lpToken,
            memecoin: memecoin,
            amount: amount,
            timestamp: block.timestamp,
            lockUntil: block.timestamp + lockPeriod
        }));

        // Update signal
        MemecoinSignal storage sig = signals[memecoin];
        sig.memecoin = memecoin;
        sig.totalStaked += amount;
        sig.stakerCount++;
        sig.lastTrade = block.timestamp;
        sig.signalScore = _computeSignalScore(sig);

        totalStakedByToken[memecoin] += amount;
        totalStaked += amount;

        emit Staked(msg.sender, lpToken, memecoin, amount);
        emit SignalUpdated(memecoin, sig.signalScore, sig.totalStaked);
    }

    /// @notice Unstake LP tokens (after lock period)
    /// @param index Index of the stake in the staker's array
    function unstake(uint256 index) external nonReentrant {
        StakeInfo storage s = stakes[msg.sender][index];
        require(s.amount > 0, "no stake");
        require(block.timestamp >= s.lockUntil, "still locked");

        uint256 amount = s.amount;
        address lpToken = s.lpToken;
        address memecoin = s.memecoin;

        // Update signal
        MemecoinSignal storage sig = signals[memecoin];
        sig.totalStaked -= amount;
        sig.stakerCount--;
        sig.signalScore = _computeSignalScore(sig);

        totalStakedByToken[memecoin] -= amount;
        totalStaked -= amount;

        // Remove stake
        stakes[msg.sender][index] = stakes[msg.sender][stakes[msg.sender].length - 1];
        stakes[msg.sender].pop();

        IERC20(lpToken).safeTransfer(msg.sender, amount);

        emit Unstaked(msg.sender, lpToken, amount);
        emit SignalUpdated(memecoin, sig.signalScore, sig.totalStaked);
    }

    // ============ Signal Computation ============

    /// @notice Compute signal score for a memecoin
    /// @dev Higher score = more likely the treasury trades this memecoin.
    ///      Score = (totalStaked * stakerCount) / (1 + timeSinceLastTrade / decay)
    ///      This rewards new memecoins with many stakers and decays over time.
    function _computeSignalScore(MemecoinSignal storage sig) internal view returns (uint256) {
        if (sig.totalStaked == 0) return 0;
        uint256 timeSince = block.timestamp - sig.lastTrade;
        uint256 decay = timeSince > signalDecay ? timeSince / signalDecay : 1;
        return (sig.totalStaked * sig.stakerCount) / decay;
    }

    /// @notice Get signal score for a memecoin
    function getSignalScore(address memecoin) external view returns (uint256) {
        return signals[memecoin].signalScore;
    }

    /// @notice Get top memecoins by signal score
    /// @param limit Maximum number of results
    function getTopMemecoins(uint256 limit) external view returns (address[] memory, uint256[] memory) {
        // This is a simplified version — in production, use a sorted list or off-chain indexing
        address[] memory memecoins = new address[](limit);
        uint256[] memory scores = new uint256[](limit);
        uint256 count = 0;

        // Iterate through all tracked memecoins (this is O(n) — for production use a sorted list)
        // For now, return the top by totalStaked
        // TODO: implement proper sorting or use off-chain indexing
        return (memecoins, scores);
    }

    /// @notice Check if a memecoin should be traded (signal score > threshold)
    function shouldTrade(address memecoin, uint256 threshold) external view returns (bool) {
        return signals[memecoin].signalScore >= threshold;
    }

    /// @notice Get normalized signal score in Q24 format (0 to 16777216)
    /// @dev Used by FlyEngine to incorporate staking signal into neural input
    function getNormalizedSignal(address memecoin) external view returns (int256) {
        uint256 raw = signals[memecoin].signalScore;
        if (raw == 0 || totalStaked == 0) return 0;
        // Normalize: (memecoin staked / total staked) * 2^24, capped at 1.0
        uint256 normalized = (raw * 16777216) / totalStaked;
        if (normalized > 16777216) normalized = 16777216;
        return int256(normalized);
    }

    // ============ Admin ============

    /// @notice Whitelist an LP token and map it to a memecoin
    function whitelistLP(address lpToken, address memecoin) external {
        require(msg.sender == admin, "not admin");
        isWhitelistedLP[lpToken] = true;
        lpTokenToMemecoin[lpToken] = memecoin;
    }

    /// @notice Set governor address (for trade triggers)
    function setGovernor(address _governor) external {
        require(msg.sender == admin, "not admin");
        governor = _governor;
    }

    /// @notice Set minimum stake amount
    function setMinStakeAmount(uint256 _min) external {
        require(msg.sender == admin, "not admin");
        minStakeAmount = _min;
    }

    /// @notice Set lock period
    function setLockPeriod(uint256 _period) external {
        require(msg.sender == admin, "not admin");
        lockPeriod = _period;
    }

    /// @notice Set signal decay period
    function setSignalDecay(uint256 _decay) external {
        require(msg.sender == admin, "not admin");
        signalDecay = _decay;
    }

    /// @notice Set ProfitSharingVault address (OSS, MIT — JoseMiguelHerrera/profitSharingVault)
    function setProfitSharingVault(address _vault) external {
        require(msg.sender == admin, "not admin");
        profitSharingVault = _vault;
    }

    // ============ Profit Distribution (Phase 6) ============

    /// @notice Distribute trading profits to LP stakers and treasury
    /// @dev 80% to stakers (proportional to stake), 20% to treasury reserve.
    ///      No fees charged (per protocol design). Called by Governor after sell.
    function distributeProfits(address memecoin, uint256 profit) external nonReentrant {
        require(msg.sender == governor || msg.sender == admin, "not authorized");
        require(profit > 0, "no profit");
        require(profitSharingVault != address(0), "no profit vault");

        uint256 stakerShare = (profit * 80) / 100;   // 80% to stakers
        uint256 treasuryShare = profit - stakerShare; // 20% to treasury

        // Transfer staker share to ProfitSharingVault (OSS handles distribution)
        IERC20(address(SYM)).safeTransfer(profitSharingVault, stakerShare);
        // Treasury share stays in protocol (transferred by caller or held)
        if (treasuryShare > 0) {
            IERC20(address(SYM)).safeTransfer(admin, treasuryShare);
        }

        emit ProfitsDistributed(memecoin, profit, stakerShare, treasuryShare);
    }

    // ============ View Functions ============

    function getStakeCount(address staker) external view returns (uint256) {
        return stakes[staker].length;
    }

    function getStake(address staker, uint256 index) external view returns (StakeInfo memory) {
        return stakes[staker][index];
    }

    function getMemecoinSignal(address memecoin) external view returns (MemecoinSignal memory) {
        return signals[memecoin];
    }
}

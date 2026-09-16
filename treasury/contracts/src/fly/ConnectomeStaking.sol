// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title ConnectomeStaking — back a specific connectome, earn its trading profits
/// @notice Holders stake SYM to a specific connectome and earn a pro-rata share
///         of that connectome's distributed profit. Stakers back real
///         performance, not issuance. Early unstake (<7d) burns 10%.
contract ConnectomeStaking is AccessControl, Pausable {
    using SafeERC20 for IERC20;

    bytes32 public constant CONNECTOME_ROLE = keccak256("CONNECTOME_ROLE");
    address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    IERC20 public immutable token; // SYM

    mapping(bytes32 => uint256) public totalStaked;
    mapping(bytes32 => mapping(address => uint256)) public staked;
    mapping(bytes32 => mapping(address => uint256)) public stakedAt;

    // Rewards: rewardPool accumulates; claimed tracks paid-out share basis
    mapping(bytes32 => uint256) public rewardPool;
    mapping(bytes32 => mapping(address => uint256)) public claimed;

    uint256 public constant UNSTAKE_PENALTY_BPS = 1000; // 10%
    uint256 public constant MIN_STAKE_DURATION = 7 days;

    event Staked(bytes32 indexed connectomeId, address indexed user, uint256 amount);
    event Unstaked(bytes32 indexed connectomeId, address indexed user, uint256 amount, uint256 penalty);
    event RewardsDistributed(bytes32 indexed connectomeId, uint256 amount);
    event RewardClaimed(bytes32 indexed connectomeId, address indexed user, uint256 amount);

    error ZeroAmount();
    error InsufficientStake();
    error NothingToClaim();

    constructor(address _token, address _admin) {
        token = IERC20(_token);
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
    }

    function stake(bytes32 connectomeId, uint256 amount) external whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        token.safeTransferFrom(msg.sender, address(this), amount);
        staked[connectomeId][msg.sender] += amount;
        stakedAt[connectomeId][msg.sender] = block.timestamp;
        totalStaked[connectomeId] += amount;
        emit Staked(connectomeId, msg.sender, amount);
    }

    function unstake(bytes32 connectomeId, uint256 amount) external {
        uint256 userStake = staked[connectomeId][msg.sender];
        if (userStake < amount) revert InsufficientStake();

        uint256 penalty = 0;
        if (block.timestamp < stakedAt[connectomeId][msg.sender] + MIN_STAKE_DURATION) {
            penalty = (amount * UNSTAKE_PENALTY_BPS) / 10000;
            // Burn if burnable (SymbientToken); else dead-sink for fixed-supply launches
            try ERC20Burnable(address(token)).burn(penalty) {} catch {
                token.safeTransfer(DEAD_ADDRESS, penalty);
            }
        }

        staked[connectomeId][msg.sender] -= amount;
        totalStaked[connectomeId] -= amount;
        token.safeTransfer(msg.sender, amount - penalty);
        emit Unstaked(connectomeId, msg.sender, amount, penalty);
    }

    /// @notice Connectome agent deposits its profit share for its stakers
    function distributeRewards(bytes32 connectomeId, uint256 amount) external onlyRole(CONNECTOME_ROLE) {
        if (amount == 0) revert ZeroAmount();
        token.safeTransferFrom(msg.sender, address(this), amount);
        rewardPool[connectomeId] += amount;
        emit RewardsDistributed(connectomeId, amount);
    }

    function claimReward(bytes32 connectomeId) external {
        uint256 userShare = calculateReward(connectomeId, msg.sender);
        uint256 claimable = userShare - claimed[connectomeId][msg.sender];
        if (claimable == 0) revert NothingToClaim();

        claimed[connectomeId][msg.sender] = userShare;
        token.safeTransfer(msg.sender, claimable);
        emit RewardClaimed(connectomeId, msg.sender, claimable);
    }

    function calculateReward(bytes32 connectomeId, address user) public view returns (uint256) {
        if (totalStaked[connectomeId] == 0) return 0;
        return (rewardPool[connectomeId] * staked[connectomeId][user]) / totalStaked[connectomeId];
    }
}

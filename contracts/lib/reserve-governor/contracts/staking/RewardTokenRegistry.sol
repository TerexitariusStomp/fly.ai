// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import { IRewardTokenRegistry } from "../interfaces/IRewardTokenRegistry.sol";
import { IRoleRegistry } from "../interfaces/IRoleRegistry.sol";

/**
 * @title RewardTokenRegistry
 * @author akshatmittal, julianmrodri, pmckelvy1, tbrent
 * @notice Singleton registry of reward tokens for StakingVaults
 */
contract RewardTokenRegistry is IRewardTokenRegistry {
    using EnumerableSet for EnumerableSet.AddressSet;

    error RewardTokenRegistry__InvalidCaller();
    error RewardTokenRegistry__ZeroAddress();
    error RewardTokenRegistry__RewardAlreadyRegistered();
    error RewardTokenRegistry__RewardNotRegistered();
    error RewardTokenRegistry__RewardDisallowed();

    event RewardTokenRegistered(address indexed rewardToken);
    event RewardTokenUnregistered(address indexed rewardToken);

    IRoleRegistry public immutable roleRegistry;

    EnumerableSet.AddressSet private _rewardTokens;
    mapping(address token => bool isDisallowed) public disallowedRewardTokens;

    constructor(IRoleRegistry _roleRegistry) {
        if (!(address(_roleRegistry) != address(0))) revert RewardTokenRegistry__ZeroAddress();

        roleRegistry = _roleRegistry;
    }

    function registerRewardToken(address rewardToken) external {
        if (!(roleRegistry.isOwner(msg.sender))) revert RewardTokenRegistry__InvalidCaller();
        if (!(rewardToken != address(0))) revert RewardTokenRegistry__ZeroAddress();
        if (!(_rewardTokens.add(rewardToken))) revert RewardTokenRegistry__RewardAlreadyRegistered();
        if (!(!disallowedRewardTokens[rewardToken])) revert RewardTokenRegistry__RewardDisallowed();

        emit RewardTokenRegistered(rewardToken);
    }

    function unregisterRewardToken(address rewardToken) external {
        if (!(roleRegistry.isOwnerOrEmergencyCouncil(msg.sender))) revert RewardTokenRegistry__InvalidCaller();
        if (!(_rewardTokens.remove(rewardToken))) revert RewardTokenRegistry__RewardNotRegistered();

        disallowedRewardTokens[rewardToken] = true;

        emit RewardTokenUnregistered(rewardToken);
    }

    function rewardTokens() external view returns (address[] memory) {
        return _rewardTokens.values();
    }

    function isRegistered(address rewardToken) external view returns (bool) {
        return _rewardTokens.contains(rewardToken);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IReserveOptimisticGovernorDeployer } from "./interfaces/IDeployer.sol";
import { IRoleRegistry } from "./interfaces/IRoleRegistry.sol";

import { Versioned } from "./utils/Versioned.sol";

/**
 * @title ReserveOptimisticGovernanceVersionRegistry
 * @author akshatmittal, julianmrodri, pmckelvy1, tbrent
 * @notice ReserveOptimisticGovernanceVersionRegistry tracks ReserveOptimisticGovernorDeployers by their
 * version string
 */
contract ReserveOptimisticGovernanceVersionRegistry {
    error VersionRegistry__InvalidCaller();
    error VersionRegistry__ZeroAddress();
    error VersionRegistry__InvalidRegistration();
    error VersionRegistry__AlreadyDeprecated();
    error VersionRegistry__NotConfigured();

    event VersionRegistered(bytes32 indexed versionHash, address deployer);
    event VersionDeprecated(bytes32 indexed versionHash);

    IRoleRegistry public immutable roleRegistry;

    mapping(bytes32 => IReserveOptimisticGovernorDeployer) public deployments;
    mapping(bytes32 => bool) public isDeprecated;
    bytes32 private latestVersion;

    constructor(IRoleRegistry _roleRegistry) {
        if (!(address(_roleRegistry) != address(0))) revert VersionRegistry__ZeroAddress();

        roleRegistry = _roleRegistry;
    }

    function registerVersion(IReserveOptimisticGovernorDeployer deployer) external {
        if (!(roleRegistry.isOwner(msg.sender))) revert VersionRegistry__InvalidCaller();

        if (!(address(deployer) != address(0))) revert VersionRegistry__ZeroAddress();

        string memory version = Versioned(address(deployer)).version();
        bytes32 versionHash = keccak256(abi.encodePacked(version));

        if (!(address(deployments[versionHash]) == address(0))) revert VersionRegistry__InvalidRegistration();

        deployments[versionHash] = deployer;
        latestVersion = versionHash;

        emit VersionRegistered(versionHash, address(deployer));
    }

    function deprecateVersion(bytes32 versionHash) external {
        if (!(roleRegistry.isOwnerOrEmergencyCouncil(msg.sender))) revert VersionRegistry__InvalidCaller();

        if (!(!isDeprecated[versionHash])) revert VersionRegistry__AlreadyDeprecated();

        isDeprecated[versionHash] = true;

        emit VersionDeprecated(versionHash);
    }

    function getLatestVersion()
        external
        view
        returns (
            bytes32 versionHash,
            string memory version,
            IReserveOptimisticGovernorDeployer deployer,
            bool deprecated
        )
    {
        versionHash = latestVersion;
        deployer = deployments[versionHash];

        if (!(address(deployer) != address(0))) revert VersionRegistry__NotConfigured();

        version = Versioned(address(deployer)).version();
        deprecated = isDeprecated[versionHash];
    }

    function getImplementationsForVersion(bytes32 versionHash)
        external
        view
        returns (address stakingVaultImpl, address governorImpl, address timelockImpl)
    {
        return (
            deployments[versionHash].stakingVaultImpl(),
            deployments[versionHash].governorImpl(),
            deployments[versionHash].timelockImpl()
        );
    }
}

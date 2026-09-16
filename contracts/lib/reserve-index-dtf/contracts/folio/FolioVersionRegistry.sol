// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { IRoleRegistry } from "@interfaces/IRoleRegistry.sol";
import { IFolioDeployer } from "@interfaces/IFolioDeployer.sol";
import { IFolioVersionRegistry } from "@interfaces/IFolioVersionRegistry.sol";

import { Versioned } from "@utils/Versioned.sol";

/**
 * @title FolioVersionRegistry
 * @author akshatmittal, julianmrodri, pmckelvy1, tbrent
 * @notice FolioVersionRegistry tracks Folio deployments by their version string
 * @dev Operationally, old Folio versions should be deprecated as new versions are registered.
 *      Keeping only one non-deprecated version live at a time limits downgrade paths and reduces
 *      the chance that governance or callers select stale Folio implementations.
 */
contract FolioVersionRegistry is IFolioVersionRegistry {
    IRoleRegistry public immutable roleRegistry;

    mapping(bytes32 => IFolioDeployer) public deployments;
    mapping(bytes32 => bool) public isDeprecated;
    bytes32 private latestVersion;

    constructor(IRoleRegistry _roleRegistry) {
        if (!(address(_roleRegistry) != address(0))) revert VersionRegistry__ZeroAddress();

        roleRegistry = _roleRegistry;
    }

    /// @dev Registering a new version does not automatically deprecate the previous version.
    ///      Registry owners should deprecate old versions before registering replacements, or do both
    ///      atomically, so getLatestVersion() is generally the only non-deprecated Folio version.
    function registerVersion(IFolioDeployer folioDeployer) external {
        if (!(roleRegistry.isOwner(msg.sender))) revert VersionRegistry__InvalidCaller();

        if (!(address(folioDeployer) != address(0))) revert VersionRegistry__ZeroAddress();

        string memory version = Versioned(address(folioDeployer)).version();
        bytes32 versionHash = keccak256(abi.encodePacked(version));

        if (!(address(deployments[versionHash]) == address(0))) revert VersionRegistry__InvalidRegistration();

        deployments[versionHash] = folioDeployer;
        latestVersion = versionHash;

        emit VersionRegistered(versionHash, folioDeployer);
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
        returns (bytes32 versionHash, string memory version, IFolioDeployer folioDeployer, bool deprecated)
    {
        versionHash = latestVersion;
        folioDeployer = deployments[versionHash];

        if (!(address(folioDeployer) != address(0))) revert VersionRegistry__Unconfigured();

        version = Versioned(address(folioDeployer)).version();
        deprecated = isDeprecated[versionHash];
    }

    function getImplementationForVersion(bytes32 versionHash) external view returns (address folio) {
        return deployments[versionHash].folioImplementation();
    }
}

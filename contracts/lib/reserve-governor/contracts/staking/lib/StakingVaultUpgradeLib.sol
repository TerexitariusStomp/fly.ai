// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ReserveOptimisticGovernanceVersionRegistry } from "@src/VersionRegistry.sol";
import { Versioned } from "@utils/Versioned.sol";

library StakingVaultUpgradeLib {
    error Vault__VersionDeprecated(bytes32 versionHash);
    error Vault__NotLatestStakingVault(address stakingVaultImpl);

    function authorizeUpgrade(ReserveOptimisticGovernanceVersionRegistry versionRegistry, address stakingVaultImpl)
        external
        view
    {
        bytes32 versionHash = keccak256(abi.encodePacked(Versioned(stakingVaultImpl).version()));

        // RoleRegistry SHOULD maintain fresh latest versions

        (bytes32 latestVersionHash,,, bool deprecated) = versionRegistry.getLatestVersion();
        if (!(!deprecated)) revert Vault__VersionDeprecated(versionHash);
        if (!(versionHash == latestVersionHash)) revert Vault__NotLatestStakingVault(stakingVaultImpl);

        (address latestStakingVaultImpl,,) = versionRegistry.getImplementationsForVersion(versionHash);
        if (!(latestStakingVaultImpl == stakingVaultImpl)) revert Vault__NotLatestStakingVault(stakingVaultImpl);
    }
}

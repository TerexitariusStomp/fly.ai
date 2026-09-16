// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ReserveOptimisticGovernor } from "@governance/ReserveOptimisticGovernor.sol";

/// @dev Mock V2 implementation for upgrade testing
contract ReserveOptimisticGovernorV2Mock is ReserveOptimisticGovernor {
    function version() public pure override returns (string memory) {
        return "2.0.0";
    }
}

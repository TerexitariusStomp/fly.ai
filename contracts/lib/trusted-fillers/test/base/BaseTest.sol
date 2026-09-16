// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";

import { MockRoleRegistry } from "@mock/MockRoleRegistry.sol";
import { cowSwapFillerConfig, deployCowSwapFiller } from "@script/DeployCowSwapFiller.s.sol";
import { IRoleRegistry, TrustedFillerRegistry } from "@src/TrustedFillerRegistry.sol";

import { CowSwapFiller } from "@src/fillers/cowswap/CowSwapFiller.sol";

abstract contract BaseTest is Test {
    IRoleRegistry public roleRegistry;
    TrustedFillerRegistry public trustedFillerRegistry;

    CowSwapFiller public cowSwapFiller;

    function setUp() public {
        roleRegistry = new MockRoleRegistry();
        trustedFillerRegistry = new TrustedFillerRegistry(address(roleRegistry));

        cowSwapFiller = deployCowSwapFiller(cowSwapFillerConfig());

        trustedFillerRegistry.addTrustedFiller(cowSwapFiller);

        _setUp();
    }

    /// @dev Implement this if you want a custom configured deployment
    function _setUp() public virtual { }
}

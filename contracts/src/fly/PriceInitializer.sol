// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

import {Kernel, Policy, Keycode, toKeycode, Permissions} from "@olympus-v3/Kernel.sol";
import {PRICEv1} from "@olympus-v3/modules/PRICE/PRICE.v1.sol";

/// @title PriceInitializer — One-shot policy to initialize SymbientPrice module
contract PriceInitializer is Policy {
    constructor(Kernel kernel_) Policy(kernel_) {}

    function configureDependencies() external override returns (Keycode[] memory dependencies) {
        dependencies = new Keycode[](1);
        dependencies[0] = toKeycode("PRICE");
    }

    function requestPermissions() external view override returns (Permissions[] memory requests) {
        requests = new Permissions[](1);
        requests[0] = Permissions({
            keycode: toKeycode("PRICE"),
            funcSelector: PRICEv1.initialize.selector
        });
    }

    /// @notice Initialize the PRICE module with start observations
    function initializePrice(uint256[] memory startObservations, uint48 lastObservationTime) external {
        PRICEv1 price = PRICEv1(getModuleAddress(toKeycode("PRICE")));
        price.initialize(startObservations, lastObservationTime);
    }
}

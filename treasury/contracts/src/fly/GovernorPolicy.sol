// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

import {Kernel, Policy, Keycode, toKeycode, Permissions} from "@olympus-v3/Kernel.sol";
import {RANGEv2} from "@olympus-v3/modules/RANGE/RANGE.v2.sol";
import {TRSRYv1} from "@olympus-v3/modules/TRSRY/TRSRY.v1.sol";
import {MINTRv1} from "@olympus-v3/modules/MINTR/MINTR.v1.sol";
import {PRICEv1} from "@olympus-v3/modules/PRICE/PRICE.v1.sol";
import {ERC20} from "solmate/tokens/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title GovernorPolicy — Kernel Policy bridging the ConnectomeGovernor to Olympus modules
/// @notice The Governor is not a Kernel Policy, so it cannot call permissioned
///         module functions directly. This policy requests all needed permissions
///         and exposes one generic executor that the Governor calls after a
///         connectome vote passes. All privileged module functionality in the
///         protocol is reachable through executeModule — connectomes control
///         TRSRY, MINTR, PRICE, and RANGE entirely.
contract GovernorPolicy is Policy {
    using SafeERC20 for IERC20;

    address public governor;

    event GovernorUpdated(address oldGov, address newGov);
    event ModuleExecuted(address indexed target, bytes data);

    modifier onlyGovernor() {
        require(msg.sender == governor, "not governor");
        _;
    }

    constructor(Kernel kernel_) Policy(kernel_) {}

    /// @dev MINTR is declared only when installed: with an external fixed-supply
    ///      SYM (e.g. a Tolly-launched token) the protocol cannot mint, so the
    ///      deployer skips the OlympusMinter module entirely.
    function configureDependencies() external override returns (Keycode[] memory dependencies) {
        bool hasMintr = address(kernel.getModuleForKeycode(toKeycode("MINTR"))) != address(0);
        dependencies = new Keycode[](hasMintr ? 4 : 3);
        dependencies[0] = toKeycode("RANGE");
        dependencies[1] = toKeycode("TRSRY");
        dependencies[2] = toKeycode("PRICE");
        if (hasMintr) dependencies[3] = toKeycode("MINTR");
    }

    /// @dev MINTR permissions are requested only when the module is installed
    ///      (external fixed-supply SYM deployments skip OlympusMinter).
    function requestPermissions() external view override returns (Permissions[] memory requests) {
        bool hasMintr = address(kernel.getModuleForKeycode(toKeycode("MINTR"))) != address(0);
        requests = new Permissions[](hasMintr ? 22 : 18);
        Keycode TRSRY = toKeycode("TRSRY");
        Keycode PRICE = toKeycode("PRICE");
        Keycode RANGE = toKeycode("RANGE");

        // TRSRY — treasury custody
        requests[0] = Permissions({keycode: TRSRY, funcSelector: TRSRYv1.withdrawReserves.selector});
        requests[1] = Permissions({keycode: TRSRY, funcSelector: TRSRYv1.incurDebt.selector});
        requests[2] = Permissions({keycode: TRSRY, funcSelector: TRSRYv1.repayDebt.selector});
        requests[3] = Permissions({keycode: TRSRY, funcSelector: TRSRYv1.increaseWithdrawApproval.selector});
        requests[4] = Permissions({keycode: TRSRY, funcSelector: TRSRYv1.decreaseWithdrawApproval.selector});
        requests[5] = Permissions({keycode: TRSRY, funcSelector: TRSRYv1.increaseDebtorApproval.selector});
        requests[6] = Permissions({keycode: TRSRY, funcSelector: TRSRYv1.decreaseDebtorApproval.selector});
        requests[7] = Permissions({keycode: TRSRY, funcSelector: TRSRYv1.setDebt.selector});

        uint256 i = 8;
        if (hasMintr) {
            // MINTR — SYM issuance (protocol-mintable token only)
            Keycode MINTR = toKeycode("MINTR");
            requests[i++] = Permissions({keycode: MINTR, funcSelector: MINTRv1.mintOhm.selector});
            requests[i++] = Permissions({keycode: MINTR, funcSelector: MINTRv1.burnOhm.selector});
            requests[i++] = Permissions({keycode: MINTR, funcSelector: MINTRv1.increaseMintApproval.selector});
            requests[i++] = Permissions({keycode: MINTR, funcSelector: MINTRv1.decreaseMintApproval.selector});
        }

        // PRICE — oracle config
        requests[i++] = Permissions({keycode: PRICE, funcSelector: PRICEv1.changeMovingAverageDuration.selector});
        requests[i++] = Permissions({keycode: PRICE, funcSelector: PRICEv1.changeObservationFrequency.selector});
        requests[i++] = Permissions({keycode: PRICE, funcSelector: PRICEv1.changeUpdateThresholds.selector});
        requests[i++] = Permissions({keycode: PRICE, funcSelector: PRICEv1.changeMinimumTargetPrice.selector});

        // RANGE — RBS params
        requests[i++] = Permissions({keycode: RANGE, funcSelector: RANGEv2.setSpreads.selector});
        requests[i++] = Permissions({keycode: RANGE, funcSelector: RANGEv2.setThresholdFactor.selector});
        requests[i++] = Permissions({keycode: RANGE, funcSelector: RANGEv2.updateCapacity.selector});
        requests[i++] = Permissions({keycode: RANGE, funcSelector: RANGEv2.updatePrices.selector});
        requests[i++] = Permissions({keycode: RANGE, funcSelector: RANGEv2.regenerate.selector});
        requests[i++] = Permissions({keycode: RANGE, funcSelector: RANGEv2.updateMarket.selector});
    }

    function setGovernor(address gov) external {
        require(governor == address(0) || msg.sender == governor, "not governor");
        emit GovernorUpdated(governor, gov);
        governor = gov;
    }

    // ============ Generic module executor ============

    /// @notice Call any permissioned module function. The module sees THIS policy
    ///         as the caller, so kernel policy-permission checks pass.
    /// @dev    Governor proposals target this function to reach TRSRY/MINTR/PRICE/RANGE.
    function executeModule(address target, bytes calldata data) external onlyGovernor returns (bytes memory) {
        (bool ok, bytes memory result) = target.call(data);
        require(ok, "module call failed");
        emit ModuleExecuted(target, data);
        return result;
    }

    /// @notice Approve an ERC20 spend from funds held by this policy.
    /// @dev    Used to fund the inverse-bond buyback float: withdraw reserves to
    ///         this policy, then approve the bond to pull payoutToken on sells.
    function approveToken(address token, address spender, uint256 amount) external onlyGovernor {
        IERC20(token).approve(spender, amount);
    }

    // ============ Typed convenience wrappers ============

    function rangeSetSpreads(bool high_, uint256 cushionSpread_, uint256 wallSpread_) external onlyGovernor {
        RANGEv2(getModuleAddress(toKeycode("RANGE"))).setSpreads(high_, cushionSpread_, wallSpread_);
    }

    function rangeSetThresholdFactor(uint256 thresholdFactor_) external onlyGovernor {
        RANGEv2(getModuleAddress(toKeycode("RANGE"))).setThresholdFactor(thresholdFactor_);
    }

    function rangeUpdateCapacity(bool high_, uint256 capacity_) external onlyGovernor {
        RANGEv2(getModuleAddress(toKeycode("RANGE"))).updateCapacity(high_, capacity_);
    }

    function rangeUpdatePrices(uint256 target_) external onlyGovernor {
        RANGEv2(getModuleAddress(toKeycode("RANGE"))).updatePrices(target_);
    }

    function trsryWithdrawReserves(address to_, address token_, uint256 amount_) external onlyGovernor {
        TRSRYv1(getModuleAddress(toKeycode("TRSRY"))).withdrawReserves(to_, ERC20(token_), amount_);
    }
}

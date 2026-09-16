// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title SymbientToken
/// @notice The SYM token — treasury-backed, connectome-governed (Olympus V3 fork pattern)
/// @dev All protocol control is via multisig (Gnosis Safe). No single-key access.
///      Fortress DAO lesson: single individual controlling treasury = catastrophic.
///      Minotaur lesson: single admin key compromise = total loss.
///      Uses OZ ERC20Burnable (MIT) for burn functionality.
contract SymbientToken is ERC20Permit, ERC20Burnable, AccessControl {
    bytes32 public constant MULTISIG_ROLE = keccak256("MULTISIG_ROLE");
    error ZeroAddress();

    error MaxSupplyExceeded();
    error NotAuthorized();
    error NotAuthorizedMinter();

    uint256 public constant MAX_SUPPLY = 100_000_000 * 1e18; // 100M cap

    /// @notice Authorized minter (Olympus MINTR module) — can mint without multisig
    address public authorizedMinter;

    event AuthorizedMinterSet(address indexed minter);

    constructor(address _multisig) ERC20("SYM", "SYM") ERC20Permit("SYM") AccessControl() {
        _grantRole(DEFAULT_ADMIN_ROLE, _multisig);
        _grantRole(MULTISIG_ROLE, _multisig);
        if (_multisig == address(0)) revert ZeroAddress();
    }

    function mint(address to, uint256 amount) external {
        if (!hasRole(MULTISIG_ROLE, msg.sender) && msg.sender != authorizedMinter) revert NotAuthorizedMinter();
        if (to == address(0)) revert ZeroAddress();
        if (totalSupply() + amount > MAX_SUPPLY) revert MaxSupplyExceeded();
        _mint(to, amount);
    }

    /// @notice Set authorized minter (Olympus MINTR module) — only multisig
    function setAuthorizedMinter(address _minter) external onlyRole(MULTISIG_ROLE) {
        authorizedMinter = _minter;
        emit AuthorizedMinterSet(_minter);
    }

}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { MockERC20 } from "@mock/MockERC20.sol";

contract MockRevertingERC20 is MockERC20 {
    address public revertingBalanceOfAccount;
    address public revertingReceiver;

    constructor(string memory name_, string memory symbol_, uint256 decimals_) MockERC20(name_, symbol_, decimals_) { }

    function setRevertingBalanceOfAccount(address account) external {
        revertingBalanceOfAccount = account;
    }

    function setRevertingReceiver(address account) external {
        revertingReceiver = account;
    }

    function balanceOf(address account) public view override returns (uint256) {
        require(account != revertingBalanceOfAccount, "MockRevertingERC20: balanceOf reverted");
        return super.balanceOf(account);
    }

    function _update(address from, address to, uint256 value) internal override {
        require(from == address(0) || to != revertingReceiver, "MockRevertingERC20: transfer reverted");
        super._update(from, to, value);
    }
}

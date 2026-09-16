// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";

import { MockEIP712 } from "@mock/MockEIP712.sol";
import { MockERC20 } from "@mock/MockERC20.sol";
import { FillerConfig, cowSwapFillerConfig } from "@script/DeployCowSwapFiller.s.sol";
import { BaseTest, CowSwapFiller } from "@test/base/BaseTest.sol";

import { IBaseTrustedFiller } from "@interfaces/IBaseTrustedFiller.sol";

import { GPv2Settlement } from "@src/fillers/cowswap/Constants.sol";
import { GPv2OrderLib } from "@src/fillers/cowswap/GPv2OrderLib.sol";

contract CowSwapFillerFillerTest is BaseTest {
    CowSwapFiller trustedFiller;

    MockERC20 sellToken;
    MockERC20 buyToken;

    uint256 sellAmount = 1e18;
    uint256 minBuyAmount = 1e18;

    function _setUp() public override {
        sellToken = new MockERC20("Sell Token", "SELL", 18);
        buyToken = new MockERC20("Buy Token", "BUY", 18);

        sellToken.mint(address(this), sellAmount);
        buyToken.mint(address(this), minBuyAmount);

        trustedFiller = CowSwapFiller(
            address(trustedFillerRegistry.createTrustedFiller(address(this), address(cowSwapFiller), bytes32(0)))
        );

        sellToken.approve(address(trustedFiller), sellAmount);
        trustedFiller.initialize(address(this), sellToken, buyToken, sellAmount, minBuyAmount);

        FillerConfig memory fillerConfig = cowSwapFillerConfig();

        // deploy a MockEIP712 to the settlement address
        address mockEIP712 = address(new MockEIP712(0xc078f884a2676e1345748b1feace7b0abee5d00ecadb6e574dcdd109a63e8943));
        vm.etch(fillerConfig.settlement, mockEIP712.code);
    }

    function test_CowSwap_correctInitialization() public view {
        FillerConfig memory fillerConfig = cowSwapFillerConfig();

        assertTrue(trustedFiller.fillCreator() == address(this));
        assertTrue(trustedFiller.sellToken() == sellToken);
        assertTrue(trustedFiller.buyToken() == buyToken);
        assertTrue(trustedFiller.sellAmount() == sellAmount);
        assertTrue(trustedFiller.price() == 1e27);
        assertEq(address(trustedFiller.GPV2_SETTLEMENT()), fillerConfig.settlement);
        assertEq(trustedFiller.GPV2_VAULT_RELAYER(), fillerConfig.vaultRelayer);
    }

    function test_CowSwap_constructorValidation() public {
        FillerConfig memory fillerConfig = cowSwapFillerConfig();

        vm.expectRevert(CowSwapFiller.CowSwapFiller__InvalidConfiguration.selector);
        new CowSwapFiller(address(0), fillerConfig.vaultRelayer);

        vm.expectRevert(CowSwapFiller.CowSwapFiller__InvalidConfiguration.selector);
        new CowSwapFiller(fillerConfig.settlement, address(0));
    }

    function test_CowSwap_isValidSignature_orderHash() public {
        GPv2OrderLib.Data memory order = GPv2OrderLib.Data({
            sellToken: sellToken,
            buyToken: buyToken,
            receiver: address(trustedFiller),
            sellAmount: sellAmount,
            buyAmount: minBuyAmount,
            validTo: uint32(block.timestamp + 1),
            appData: bytes32(0),
            feeAmount: 0,
            kind: GPv2OrderLib.KIND_SELL,
            partiallyFillable: true,
            sellTokenBalance: GPv2OrderLib.BALANCE_ERC20,
            buyTokenBalance: GPv2OrderLib.BALANCE_ERC20
        });
        bytes32 orderHash = GPv2OrderLib.hash(order, GPv2Settlement(cowSwapFillerConfig().settlement).domainSeparator());

        bytes4 returnSelector = trustedFiller.isValidSignature(orderHash, abi.encode(order));
        assertTrue(returnSelector == trustedFiller.isValidSignature.selector);

        vm.expectRevert();
        trustedFiller.isValidSignature(bytes32(uint256(123)), abi.encode(order));
    }

    function test_CowSwap_getOrderHash() public view {
        GPv2OrderLib.Data memory order = GPv2OrderLib.Data({
            sellToken: sellToken,
            buyToken: buyToken,
            receiver: address(trustedFiller),
            sellAmount: sellAmount,
            buyAmount: minBuyAmount,
            validTo: uint32(block.timestamp + 1),
            appData: bytes32(0),
            feeAmount: 0,
            kind: GPv2OrderLib.KIND_SELL,
            partiallyFillable: true,
            sellTokenBalance: GPv2OrderLib.BALANCE_ERC20,
            buyTokenBalance: GPv2OrderLib.BALANCE_ERC20
        });
        bytes32 orderHash = GPv2OrderLib.hash(order, GPv2Settlement(cowSwapFillerConfig().settlement).domainSeparator());
        bytes32 returnHash = trustedFiller.getOrderHash(abi.encode(order));

        vm.assertTrue(returnHash == orderHash);
    }

    function test_CowSwap_swapActive() public {
        assertFalse(trustedFiller.swapActive());

        sellToken.burn(address(trustedFiller), sellAmount);
        assertTrue(trustedFiller.swapActive());

        vm.expectRevert(abi.encodeWithSelector(IBaseTrustedFiller.BaseTrustedFiller__SwapActive.selector));
        trustedFiller.closeFiller();
    }

    function test_CowSwap_emergencyCloseFiller_revertsInInitializationBlock() public {
        vm.expectRevert(abi.encodeWithSelector(CowSwapFiller.CowSwapFiller__Unauthorized.selector));
        trustedFiller.emergencyCloseFiller();
    }

    function test_CowSwap_emergencyCloseFiller_rescuesTokensAfterInitializationBlock() public {
        vm.roll(block.number + 1);
        trustedFiller.emergencyCloseFiller();

        assertEq(sellToken.balanceOf(address(this)), sellAmount);
        assertEq(sellToken.balanceOf(address(trustedFiller)), 0);
    }

    function test_CowSwap_setPartiallyFillable_onlyInInitializationBlock() public {
        trustedFiller.setPartiallyFillable(false);
        assertFalse(trustedFiller.partiallyFillable());

        vm.roll(block.number + 1);

        vm.expectRevert(abi.encodeWithSelector(CowSwapFiller.CowSwapFiller__Unauthorized.selector));
        trustedFiller.setPartiallyFillable(true);
    }
}

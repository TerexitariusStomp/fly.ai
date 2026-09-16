// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";

import { IBaseTrustedFiller } from "@interfaces/IBaseTrustedFiller.sol";
import { ITrustedFillerRegistry } from "@interfaces/ITrustedFillerRegistry.sol";
import { MockERC1271MultisigSigner } from "@mock/MockERC1271MultisigSigner.sol";
import { MockERC1271Signer } from "@mock/MockERC1271Signer.sol";
import { MockERC20 } from "@mock/MockERC20.sol";
import { MockRevertingERC20 } from "@mock/MockRevertingERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { cowSwapFillerConfig, deployCowSwapFiller } from "@script/DeployCowSwapFiller.s.sol";
import { GenericTokenJar } from "@src/extras/GenericTokenJar.sol";
import { CowSwapFiller } from "@src/fillers/cowswap/CowSwapFiller.sol";
import { BaseTest } from "@test/base/BaseTest.sol";

contract GenericTokenJarTest is BaseTest {
    GenericTokenJar jar;

    MockERC20 sellToken;
    MockERC20 secondSellToken;
    MockERC20 buyToken;

    address destination = address(0xBEEF);

    uint256 ownerPk;
    address owner;

    uint256 constant SELL_AMOUNT = 1e18;
    uint256 constant MIN_BUY_AMOUNT = 2e18;

    function _setUp() public override {
        sellToken = new MockERC20("Sell Token", "SELL", 18);
        secondSellToken = new MockERC20("Second Sell Token", "SELL2", 18);
        buyToken = new MockERC20("Buy Token", "BUY", 18);

        ownerPk = 0xb93542f3d387519a84549b74c3f1948cff1b08ec464ee031e4068901648fa726;
        owner = vm.addr(ownerPk);

        jar = new GenericTokenJar(destination, buyToken, owner, trustedFillerRegistry);
    }

    function _defaultRequest() internal view returns (GenericTokenJar.FillRequest memory request) {
        request = GenericTokenJar.FillRequest({
            targetFiller: address(cowSwapFiller),
            relayer: address(this),
            sellToken: address(sellToken),
            sellAmount: SELL_AMOUNT,
            minBuyAmount: MIN_BUY_AMOUNT,
            deploymentSalt: bytes32(uint256(1)),
            deadline: block.timestamp + 1 days
        });
    }

    function _signRequest(GenericTokenJar.FillRequest memory request, uint256 signerPk)
        internal
        view
        returns (bytes memory signature)
    {
        signature = _signRequestForJar(jar, request, signerPk);
    }

    function _signRequestForJar(GenericTokenJar targetJar, GenericTokenJar.FillRequest memory request, uint256 signerPk)
        internal
        view
        returns (bytes memory signature)
    {
        bytes32 digest = targetJar.getFillRequestHash(request);
        signature = _signDigest(digest, signerPk);
    }

    function _signDigest(bytes32 digest, uint256 signerPk) internal pure returns (bytes memory signature) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, digest);
        signature = abi.encodePacked(r, s, v);
    }

    function _fundJar(GenericTokenJar.FillRequest memory request) internal {
        MockERC20(request.sellToken).mint(address(jar), request.sellAmount);
    }

    function test_GenericTokenJar_constructorValidation() public {
        vm.expectRevert(abi.encodeWithSelector(GenericTokenJar.GenericTokenJar__InvalidInitialization.selector, 1));
        new GenericTokenJar(address(0), buyToken, owner, trustedFillerRegistry);

        vm.expectRevert(abi.encodeWithSelector(GenericTokenJar.GenericTokenJar__InvalidInitialization.selector, 2));
        new GenericTokenJar(destination, IERC20(address(0)), owner, trustedFillerRegistry);

        vm.expectRevert(abi.encodeWithSelector(GenericTokenJar.GenericTokenJar__InvalidInitialization.selector, 3));
        new GenericTokenJar(destination, buyToken, owner, ITrustedFillerRegistry(address(0)));
    }

    function test_GenericTokenJar_createTrustedFill() public {
        GenericTokenJar.FillRequest memory request = _defaultRequest();
        _fundJar(request);

        IBaseTrustedFiller filler = jar.createTrustedFill(request, _signRequest(request, ownerPk));

        assertEq(jar.activeFillsByTokenPair(address(sellToken), address(buyToken)), address(filler));
        assertEq(CowSwapFiller(address(filler)).fillCreator(), address(jar));
        assertEq(address(filler.sellToken()), address(sellToken));
        assertEq(address(filler.buyToken()), address(buyToken));
        assertEq(filler.sellAmount(), SELL_AMOUNT);
        assertEq(sellToken.balanceOf(address(filler)), SELL_AMOUNT);
        assertEq(sellToken.balanceOf(address(jar)), 0);
    }

    function test_GenericTokenJar_createTrustedFill_acceptsERC1271OwnerSignature() public {
        MockERC1271Signer signer = new MockERC1271Signer();
        GenericTokenJar contractOwnedJar =
            new GenericTokenJar(destination, buyToken, address(signer), trustedFillerRegistry);
        GenericTokenJar.FillRequest memory request = _defaultRequest();
        bytes memory signature = abi.encodePacked("erc1271 signature");

        signer.setValidSignature(contractOwnedJar.getFillRequestHash(request), signature, true);
        MockERC20(request.sellToken).mint(address(contractOwnedJar), request.sellAmount);

        IBaseTrustedFiller filler = contractOwnedJar.createTrustedFill(request, signature);

        assertEq(contractOwnedJar.activeFillsByTokenPair(address(sellToken), address(buyToken)), address(filler));
        assertEq(CowSwapFiller(address(filler)).fillCreator(), address(contractOwnedJar));
        assertEq(sellToken.balanceOf(address(filler)), SELL_AMOUNT);
        assertEq(sellToken.balanceOf(address(contractOwnedJar)), 0);
    }

    function test_GenericTokenJar_createTrustedFill_acceptsERC1271MultisigOwnerSignature() public {
        uint256 firstSignerPk = 0xA11CE;
        uint256 secondSignerPk = 0xB0B;
        MockERC1271MultisigSigner signer =
            new MockERC1271MultisigSigner(vm.addr(firstSignerPk), vm.addr(secondSignerPk));
        GenericTokenJar contractOwnedJar =
            new GenericTokenJar(destination, buyToken, address(signer), trustedFillerRegistry);
        GenericTokenJar.FillRequest memory request = _defaultRequest();
        bytes32 digest = contractOwnedJar.getFillRequestHash(request);
        bytes memory signature = abi.encode(_signDigest(digest, firstSignerPk), _signDigest(digest, secondSignerPk));

        MockERC20(request.sellToken).mint(address(contractOwnedJar), request.sellAmount);

        IBaseTrustedFiller filler = contractOwnedJar.createTrustedFill(request, signature);

        assertEq(contractOwnedJar.activeFillsByTokenPair(address(sellToken), address(buyToken)), address(filler));
        assertEq(CowSwapFiller(address(filler)).fillCreator(), address(contractOwnedJar));
        assertEq(sellToken.balanceOf(address(filler)), SELL_AMOUNT);
        assertEq(sellToken.balanceOf(address(contractOwnedJar)), 0);
    }

    function test_GenericTokenJar_createTrustedFill_revertsOnWrongSigner() public {
        GenericTokenJar.FillRequest memory request = _defaultRequest();
        _fundJar(request);
        bytes memory signature = _signRequest(request, 0xB0B);

        vm.expectRevert(GenericTokenJar.GenericTokenJar__UnauthorizedSigner.selector);
        jar.createTrustedFill(request, signature);
    }

    function test_GenericTokenJar_createTrustedFill_revertsOnExpiredRequest() public {
        GenericTokenJar.FillRequest memory request = _defaultRequest();
        request.deadline = block.timestamp - 1;
        _fundJar(request);
        bytes memory signature = _signRequest(request, ownerPk);

        vm.expectRevert(abi.encodeWithSelector(GenericTokenJar.GenericTokenJar__InvalidRequest.selector, 7));
        jar.createTrustedFill(request, signature);
    }

    function test_GenericTokenJar_createTrustedFill_revertsOnInvalidRequest() public {
        GenericTokenJar.FillRequest memory request = _defaultRequest();
        request.targetFiller = address(0);

        vm.expectRevert(abi.encodeWithSelector(GenericTokenJar.GenericTokenJar__InvalidRequest.selector, 1));
        jar.createTrustedFill(request, "");

        request = _defaultRequest();
        request.relayer = address(0xB0B);
        vm.expectRevert(abi.encodeWithSelector(GenericTokenJar.GenericTokenJar__InvalidRequest.selector, 2));
        jar.createTrustedFill(request, "");

        request = _defaultRequest();
        request.sellToken = address(0);
        vm.expectRevert(abi.encodeWithSelector(GenericTokenJar.GenericTokenJar__InvalidRequest.selector, 3));
        jar.createTrustedFill(request, "");

        request = _defaultRequest();
        request.sellAmount = 0;
        vm.expectRevert(abi.encodeWithSelector(GenericTokenJar.GenericTokenJar__InvalidRequest.selector, 4));
        jar.createTrustedFill(request, "");

        request = _defaultRequest();
        request.minBuyAmount = 0;
        vm.expectRevert(abi.encodeWithSelector(GenericTokenJar.GenericTokenJar__InvalidRequest.selector, 5));
        jar.createTrustedFill(request, "");

        request = _defaultRequest();
        request.sellToken = address(buyToken);
        vm.expectRevert(abi.encodeWithSelector(GenericTokenJar.GenericTokenJar__InvalidRequest.selector, 6));
        jar.createTrustedFill(request, "");
    }

    function test_GenericTokenJar_createTrustedFill_revertsOnUnapprovedFiller() public {
        GenericTokenJar.FillRequest memory request = _defaultRequest();
        request.targetFiller = address(deployCowSwapFiller(cowSwapFillerConfig()));
        _fundJar(request);
        bytes memory signature = _signRequest(request, ownerPk);

        vm.expectRevert(ITrustedFillerRegistry.TrustedFillerRegistry__InvalidFiller.selector);
        jar.createTrustedFill(request, signature);
    }

    function test_GenericTokenJar_createTrustedFill_autoClosesExistingFill() public {
        GenericTokenJar.FillRequest memory request = _defaultRequest();
        _fundJar(request);
        IBaseTrustedFiller firstFiller = jar.createTrustedFill(request, _signRequest(request, ownerPk));

        request.deploymentSalt = bytes32(uint256(2));
        bytes memory signature = _signRequest(request, ownerPk);

        IBaseTrustedFiller secondFiller = jar.createTrustedFill(request, signature);

        assertEq(jar.activeFillsByTokenPair(address(sellToken), address(buyToken)), address(secondFiller));
        assertTrue(address(firstFiller) != address(secondFiller));
        assertEq(sellToken.balanceOf(address(firstFiller)), 0);
        assertEq(sellToken.balanceOf(address(secondFiller)), SELL_AMOUNT);
        assertEq(sellToken.balanceOf(address(jar)), 0);
    }

    function test_GenericTokenJar_createTrustedFill_keepsDistinctPairsActive() public {
        GenericTokenJar.FillRequest memory firstRequest = _defaultRequest();
        _fundJar(firstRequest);
        IBaseTrustedFiller firstFiller = jar.createTrustedFill(firstRequest, _signRequest(firstRequest, ownerPk));

        GenericTokenJar.FillRequest memory secondRequest = _defaultRequest();
        secondRequest.sellToken = address(secondSellToken);
        secondRequest.deploymentSalt = bytes32(uint256(2));
        _fundJar(secondRequest);
        IBaseTrustedFiller secondFiller = jar.createTrustedFill(secondRequest, _signRequest(secondRequest, ownerPk));

        assertEq(jar.activeFillsByTokenPair(address(sellToken), address(buyToken)), address(firstFiller));
        assertEq(jar.activeFillsByTokenPair(address(secondSellToken), address(buyToken)), address(secondFiller));
        assertEq(sellToken.balanceOf(address(firstFiller)), SELL_AMOUNT);
        assertEq(secondSellToken.balanceOf(address(secondFiller)), SELL_AMOUNT);
    }

    function test_GenericTokenJar_createTrustedFill_permissionlessAfterRenounce() public {
        GenericTokenJar.FillRequest memory request = _defaultRequest();
        _fundJar(request);

        vm.prank(owner);
        jar.renounceOwnership();

        IBaseTrustedFiller filler = jar.createTrustedFill(request, "");

        assertEq(jar.activeFillsByTokenPair(address(sellToken), address(buyToken)), address(filler));
        assertEq(CowSwapFiller(address(filler)).fillCreator(), address(jar));
    }

    function test_GenericTokenJar_closeTrustedFill() public {
        GenericTokenJar.FillRequest memory request = _defaultRequest();
        _fundJar(request);

        IBaseTrustedFiller filler = jar.createTrustedFill(request, _signRequest(request, ownerPk));

        sellToken.burn(address(filler), SELL_AMOUNT);
        buyToken.mint(address(filler), MIN_BUY_AMOUNT);

        jar.closeTrustedFill(address(sellToken), address(buyToken));

        assertEq(jar.activeFillsByTokenPair(address(sellToken), address(buyToken)), address(0));
        assertEq(sellToken.balanceOf(address(jar)), 0);
        assertEq(buyToken.balanceOf(address(jar)), MIN_BUY_AMOUNT);
        assertEq(sellToken.balanceOf(address(filler)), 0);
        assertEq(buyToken.balanceOf(address(filler)), 0);
    }

    function test_GenericTokenJar_closeTrustedFill_continuesWhenSellTokenRescueReverts() public {
        MockRevertingERC20 revertingSellToken = new MockRevertingERC20("Reverting Sell Token", "RSELL", 18);

        GenericTokenJar.FillRequest memory request = _defaultRequest();
        request.sellToken = address(revertingSellToken);
        _fundJar(request);

        IBaseTrustedFiller filler = jar.createTrustedFill(request, _signRequest(request, ownerPk));
        revertingSellToken.setRevertingReceiver(address(jar));
        buyToken.mint(address(filler), MIN_BUY_AMOUNT);

        vm.roll(block.number + 1);
        jar.closeTrustedFill(address(revertingSellToken), address(buyToken));

        assertEq(jar.activeFillsByTokenPair(address(revertingSellToken), address(buyToken)), address(0));
        assertEq(revertingSellToken.balanceOf(address(jar)), 0);
        assertEq(buyToken.balanceOf(address(jar)), MIN_BUY_AMOUNT);
        assertEq(revertingSellToken.balanceOf(address(filler)), SELL_AMOUNT);
        assertEq(buyToken.balanceOf(address(filler)), 0);
    }

    function test_GenericTokenJar_closeTrustedFill_continuesWhenSellTokenBalanceOfReverts() public {
        MockRevertingERC20 revertingSellToken = new MockRevertingERC20("Reverting Sell Token", "RSELL", 18);

        GenericTokenJar.FillRequest memory request = _defaultRequest();
        request.sellToken = address(revertingSellToken);
        _fundJar(request);

        IBaseTrustedFiller filler = jar.createTrustedFill(request, _signRequest(request, ownerPk));
        revertingSellToken.setRevertingBalanceOfAccount(address(filler));
        buyToken.mint(address(filler), MIN_BUY_AMOUNT);

        vm.roll(block.number + 1);
        jar.closeTrustedFill(address(revertingSellToken), address(buyToken));

        assertEq(jar.activeFillsByTokenPair(address(revertingSellToken), address(buyToken)), address(0));
        assertEq(revertingSellToken.balanceOf(address(jar)), 0);
        assertEq(buyToken.balanceOf(address(jar)), MIN_BUY_AMOUNT);

        vm.expectRevert("MockRevertingERC20: balanceOf reverted");
        revertingSellToken.balanceOf(address(filler));

        assertEq(buyToken.balanceOf(address(filler)), 0);

        revertingSellToken.setRevertingBalanceOfAccount(address(0));
        assertEq(revertingSellToken.balanceOf(address(filler)), SELL_AMOUNT);
    }

    function test_GenericTokenJar_pushTokens() public {
        GenericTokenJar.FillRequest memory request = _defaultRequest();
        _fundJar(request);

        IBaseTrustedFiller filler = jar.createTrustedFill(request, _signRequest(request, ownerPk));

        sellToken.burn(address(filler), SELL_AMOUNT);
        buyToken.mint(address(filler), MIN_BUY_AMOUNT);

        jar.closeTrustedFill(address(sellToken), address(buyToken));
        jar.pushTokens();

        assertEq(buyToken.balanceOf(destination), MIN_BUY_AMOUNT);
        assertEq(buyToken.balanceOf(address(jar)), 0);
    }
}

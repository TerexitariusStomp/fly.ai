// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { IERC20, SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IBaseTrustedFiller } from "../../interfaces/IBaseTrustedFiller.sol";

import { Versioned } from "../../utils/Versioned.sol";

import { D27, GPv2Settlement } from "./Constants.sol";
import { GPv2OrderLib } from "./GPv2OrderLib.sol";

/// Swap MUST occur in the same block as initialization
/// Expected to be newly deployed in the pre-hook of a CowSwap order
/// Ideally `closeFiller()` is called in the end as a post-hook, but this is not relied upon
contract CowSwapFiller is Initializable, IBaseTrustedFiller, Versioned {
    using GPv2OrderLib for GPv2OrderLib.Data;
    using SafeERC20 for IERC20;

    error CowSwapFiller__Unauthorized();
    error CowSwapFiller__InvalidConfiguration();
    error CowSwapFiller__OrderCheckFailed(uint256 errorCode);

    GPv2Settlement public immutable GPV2_SETTLEMENT;
    address public immutable GPV2_VAULT_RELAYER;

    address public fillCreator;

    IERC20 public sellToken;
    IERC20 public buyToken;

    uint256 public sellAmount; // {sellTok}
    uint256 public blockInitialized; // {block}

    uint256 public price; // D27{buyTok/sellTok}
    bool public partiallyFillable;

    bool public isClosed;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(address _gpv2Settlement, address _gpv2VaultRelayer) {
        if (!(
            address(_gpv2Settlement) != address(0) && _gpv2VaultRelayer != address(0)
        )) revert CowSwapFiller__InvalidConfiguration();

        GPV2_SETTLEMENT = GPv2Settlement(_gpv2Settlement);
        GPV2_VAULT_RELAYER = _gpv2VaultRelayer;

        _disableInitializers();
    }

    modifier onlyFillCreator() {
        if (!(msg.sender == fillCreator)) revert CowSwapFiller__Unauthorized();
        _;
    }

    /// Initialize the swap, transferring in `_sellAmount` of the `_sell` token
    /// @dev Built for the pre-hook of a CowSwap order, must be called via using entity
    function initialize(
        address _creator,
        IERC20 _sellToken,
        IERC20 _buyToken,
        uint256 _sellAmount,
        uint256 _minBuyAmount
    ) external initializer {
        if (!(_sellToken != _buyToken)) revert CowSwapFiller__OrderCheckFailed(200);

        fillCreator = _creator;
        sellToken = _sellToken;
        buyToken = _buyToken;
        sellAmount = _sellAmount;

        blockInitialized = block.number;
        partiallyFillable = true;

        // D27{buyTok/sellTok} = {buyTok} * D27 / {sellTok}
        price = Math.mulDiv(_minBuyAmount, D27, _sellAmount, Math.Rounding.Ceil);

        sellToken.forceApprove(GPV2_VAULT_RELAYER, _sellAmount);
        sellToken.safeTransferFrom(_creator, address(this), _sellAmount);
    }

    /// @dev Validates CowSwap order for a fill via EIP-1271
    function isValidSignature(bytes32 orderHash, bytes calldata signature) external view returns (bytes4) {
        if (!(block.number == blockInitialized)) revert CowSwapFiller__Unauthorized();

        // Decode signature to get the CowSwap order
        GPv2OrderLib.Data memory order = abi.decode(signature, (GPv2OrderLib.Data));

        // Verify Order Hash
        if (!(orderHash == order.hash(GPV2_SETTLEMENT.domainSeparator()))) revert CowSwapFiller__OrderCheckFailed(0); // Invalid Order Hash

        if (!(order.sellToken == sellToken)) revert CowSwapFiller__OrderCheckFailed(1); // Invalid Sell Token
        if (!(order.buyToken == buyToken)) revert CowSwapFiller__OrderCheckFailed(2); // Invalid Buy Token
        if (!(order.feeAmount == 0)) revert CowSwapFiller__OrderCheckFailed(3); // Must be a Limit Order
        if (!(order.receiver == address(this))) revert CowSwapFiller__OrderCheckFailed(4); // Receiver must be self
        if (!(order.sellTokenBalance == GPv2OrderLib.BALANCE_ERC20)) revert CowSwapFiller__OrderCheckFailed(5); // Must use ERC20 Balance
        if (!(order.buyTokenBalance == GPv2OrderLib.BALANCE_ERC20)) revert CowSwapFiller__OrderCheckFailed(6); // Must use ERC20 Balance
        if (!(order.sellAmount != 0)) revert CowSwapFiller__OrderCheckFailed(7); // catch div-by-zero below

        if (!partiallyFillable) {
            if (!(!order.partiallyFillable)) revert CowSwapFiller__OrderCheckFailed(8); // Invalid Partially Fillable
            if (!(order.sellAmount == sellAmount)) revert CowSwapFiller__OrderCheckFailed(9); // Invalid sell amount
        }

        // Price check, just in case
        // D27{buyTok/sellTok} = {buyTok} * D27 / {sellTok}
        uint256 orderPrice = Math.mulDiv(order.buyAmount, D27, order.sellAmount, Math.Rounding.Floor);
        if (!(orderPrice >= price)) revert CowSwapFiller__OrderCheckFailed(100);

        // If all checks pass, return the magic value
        return this.isValidSignature.selector;
    }

    /// @dev Helper function for offchain orderHash calculation & validation
    function getOrderHash(bytes calldata signature) external view returns (bytes32) {
        GPv2OrderLib.Data memory order = abi.decode(signature, (GPv2OrderLib.Data));

        return order.hash(GPV2_SETTLEMENT.domainSeparator());
    }

    /// @return true if the contract is mid-swap and funds have not yet settled
    function swapActive() public view returns (bool) {
        if (_sameBlock()) {
            uint256 sellTokenBalance = sellToken.balanceOf(address(this));

            if (sellTokenBalance >= sellAmount) {
                return false;
            }

            // {buyTok} = {sellTok} * D27{buyTok/sellTok} / D27
            uint256 minimumExpectedIn = Math.mulDiv(sellAmount - sellTokenBalance, price, D27, Math.Rounding.Ceil);

            return minimumExpectedIn > buyToken.balanceOf(address(this));
        }

        return false;
    }

    /// Collect all balances back to the beneficiary
    function closeFiller() external onlyFillCreator {
        if (!(!swapActive())) revert BaseTrustedFiller__SwapActive();

        _closeFiller(false);
    }

    function emergencyCloseFiller() external onlyFillCreator {
        if (!(!_sameBlock())) revert CowSwapFiller__Unauthorized();

        _closeFiller(true);
    }

    function setPartiallyFillable(bool _partiallyFillable) external onlyFillCreator {
        if (!(_sameBlock())) revert CowSwapFiller__Unauthorized();

        partiallyFillable = _partiallyFillable;
    }

    /// Rescue tokens in case any are left in the contract
    function rescueToken(IERC20 token) public {
        if (!(isClosed)) revert CowSwapFiller__Unauthorized(); // Close fill via `closeFiller()` first

        _rescueToken(token);
    }

    function _rescueToken(IERC20 token) internal {
        uint256 tokenBalance = token.balanceOf(address(this));

        if (tokenBalance != 0) {
            token.safeTransfer(fillCreator, tokenBalance);
        }
    }

    function _closeFiller(bool tryCatch) internal {
        isClosed = true;

        if (tryCatch) {
            try this.rescueToken(IERC20(sellToken)) { } catch { }
            try this.rescueToken(IERC20(buyToken)) { } catch { }
        } else {
            _rescueToken(IERC20(sellToken));
            _rescueToken(IERC20(buyToken));
        }
    }

    function _sameBlock() internal view returns (bool) {
        return block.number == blockInitialized;
    }
}

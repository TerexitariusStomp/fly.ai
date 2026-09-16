// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20, SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import { IBaseTrustedFiller } from "@interfaces/IBaseTrustedFiller.sol";
import { ITrustedFillerRegistry } from "@interfaces/ITrustedFillerRegistry.sol";

/**
 * @title Generic Token Jar
 * @notice Custodies arbitrary ERC20 sell tokens and routes them through any trusted
 *         filler implementation approved by the Trusted Filler Registry.
 * @dev Fill creation can be restricted to owner-signed requests. If ownership is
 *      renounced, fill creation becomes permissionless.
 */
contract GenericTokenJar is Ownable, EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant FILL_REQUEST_TYPEHASH = keccak256(
        "FillRequest(address targetFiller,address relayer,address sellToken,uint256 sellAmount,uint256 minBuyAmount,bytes32 deploymentSalt,uint256 deadline)"
    );

    address public immutable destination;
    IERC20 public immutable token;
    ITrustedFillerRegistry public immutable trustedFillerRegistry;

    mapping(address sellToken => mapping(address buyToken => address activeTrustedFill)) public activeFillsByTokenPair;

    struct FillRequest {
        address targetFiller;
        address relayer;
        address sellToken;
        uint256 sellAmount;
        uint256 minBuyAmount;
        bytes32 deploymentSalt;
        uint256 deadline;
    }

    error GenericTokenJar__InvalidInitialization(uint256 errorCode);
    error GenericTokenJar__InvalidRequest(uint256 errorCode);
    error GenericTokenJar__UnauthorizedSigner();

    event TrustedFillClosed(address indexed filler);
    event TrustedFillCreated(
        address indexed relayer,
        address indexed filler,
        address indexed sellToken,
        uint256 sellAmount,
        uint256 minBuyAmount,
        bytes32 deploymentSalt,
        uint256 deadline
    );

    constructor(address _destination, IERC20 _token, address _signer, ITrustedFillerRegistry _trustedFillerRegistry)
        Ownable(_signer)
        EIP712("GenericTokenJar", "1")
    {
        if (!(_destination != address(0))) revert GenericTokenJar__InvalidInitialization(1);
        if (!(address(_token) != address(0))) revert GenericTokenJar__InvalidInitialization(2);
        if (!(address(_trustedFillerRegistry) != address(0))) revert GenericTokenJar__InvalidInitialization(3);

        destination = _destination;
        token = _token;
        trustedFillerRegistry = _trustedFillerRegistry;
    }

    function createTrustedFill(FillRequest calldata request, bytes calldata ownerSignature)
        external
        nonReentrant
        returns (IBaseTrustedFiller filler)
    {
        _validateRequest(request);
        _closeTrustedFill(request.sellToken, address(token));

        if (owner() != address(0)) {
            bytes32 digest = _hashTypedDataV4(_hashFillRequest(request));

            if (!(
            SignatureChecker.isValidSignatureNow(owner(), digest, ownerSignature)
        )) revert GenericTokenJar__UnauthorizedSigner();
        }

        filler = trustedFillerRegistry.createTrustedFiller(msg.sender, request.targetFiller, request.deploymentSalt);
        activeFillsByTokenPair[request.sellToken][address(token)] = address(filler);

        IERC20 sellToken = IERC20(request.sellToken);

        sellToken.forceApprove(address(filler), request.sellAmount);
        filler.initialize(address(this), sellToken, token, request.sellAmount, request.minBuyAmount);

        emit TrustedFillCreated(
            msg.sender,
            address(filler),
            request.sellToken,
            request.sellAmount,
            request.minBuyAmount,
            request.deploymentSalt,
            request.deadline
        );
    }

    function closeTrustedFill(address sellToken, address buyToken) external nonReentrant {
        _closeTrustedFill(sellToken, buyToken);
    }

    function pushTokens() external nonReentrant {
        token.safeTransfer(destination, token.balanceOf(address(this)));
    }

    function getFillRequestHash(FillRequest calldata request) external view returns (bytes32) {
        return _hashTypedDataV4(_hashFillRequest(request));
    }

    function _hashFillRequest(FillRequest calldata request) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                FILL_REQUEST_TYPEHASH,
                request.targetFiller,
                request.relayer,
                request.sellToken,
                request.sellAmount,
                request.minBuyAmount,
                request.deploymentSalt,
                request.deadline
            )
        );
    }

    function _validateRequest(FillRequest calldata request) internal view {
        if (!(request.targetFiller != address(0))) revert GenericTokenJar__InvalidRequest(1);
        if (!(request.relayer == msg.sender)) revert GenericTokenJar__InvalidRequest(2);
        if (!(request.sellToken != address(0))) revert GenericTokenJar__InvalidRequest(3);
        if (!(request.sellAmount != 0)) revert GenericTokenJar__InvalidRequest(4);
        if (!(request.minBuyAmount != 0)) revert GenericTokenJar__InvalidRequest(5);
        if (!(request.sellToken != address(token))) revert GenericTokenJar__InvalidRequest(6);
        if (!(block.timestamp <= request.deadline)) revert GenericTokenJar__InvalidRequest(7);

        IBaseTrustedFiller filler = IBaseTrustedFiller(request.targetFiller);

        if (!(filler.version() >= 2)) revert GenericTokenJar__InvalidRequest(100);
    }

    function _closeTrustedFill(address sellToken, address buyToken) internal {
        address fillerAddress = activeFillsByTokenPair[sellToken][buyToken];
        if (fillerAddress == address(0)) {
            return;
        }

        IBaseTrustedFiller filler = IBaseTrustedFiller(fillerAddress);

        try filler.closeFiller() { }
        catch {
            filler.emergencyCloseFiller();
        }

        delete activeFillsByTokenPair[sellToken][buyToken];

        emit TrustedFillClosed(fillerAddress);
    }
}

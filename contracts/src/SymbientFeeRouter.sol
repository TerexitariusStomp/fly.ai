// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IUniswapV2Router02} from "./fly/ArcLaunchpadAdapter.sol";
import {SymbientStaking} from "./SymbientStaking.sol";

/// @title SymbientFeeRouter — Tolly LP fees → single treasury → staker rewards
/// @notice Closes the reward loop for an externally launched SYM (Tolly):
///         the Tolly fee locker pays the token creator a share of every buy's
///         USDC pool fee. Fees claimed here are consolidated into TRSRY — the
///         single treasury that custody's all protocol funds. Connectome
///         trading capital is then drawn from TRSRY by governor-approved
///         withdrawals (GovernorPolicy.trsryWithdrawReserves → adapter float);
///         connectomes trade that float autonomously and sell proceeds return
///         to TRSRY.
///
///         Sending rewards to stakers is a *decision*, not automation:
///         `fundRewards` is GOVERNANCE-gated (called via GovernorPolicy /
///         ConnectomeGovernor vote). The connectomes trade the funds first and
///         only convert USDC → SYM → SymbientStaking.rewardPool when they decide
///         staker rewards are needed.
contract SymbientFeeRouter is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");
    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");

    error ZeroAddress();
    error NothingToRoute();
    error NothingToFund();
    error ClaimFailed();

    IERC20 public immutable payoutToken; // USDC on Arc
    IERC20 public immutable symbientToken; // SYM
    IUniswapV2Router02 public immutable router;
    SymbientStaking public immutable staking;
    address public immutable tollyLocker; // Tolly fee locker (address(0) if unknown)

    /// @notice The single treasury (OlympusTreasury/TRSRY). All claimed fees
    ///         consolidate here; trading floats and rewards are drawn from it
    ///         via governance.
    address public treasury;

    event FeesClaimed(uint256 usdcBalance);
    event RoutedToTreasury(uint256 amount, address indexed treasury);
    event RewardsFunded(uint256 usdcIn, uint256 symbientOut, uint256 poolBalance);
    event TreasuryUpdated(address indexed treasury);

    constructor(
        address _payoutToken,
        address _symbientToken,
        address _router,
        address _staking,
        address _tollyLocker,
        address _treasury,
        address _admin
    ) {
        if (
            _payoutToken == address(0) || _symbientToken == address(0) || _router == address(0)
                || _staking == address(0) || _admin == address(0)
        ) revert ZeroAddress();
        payoutToken = IERC20(_payoutToken);
        symbientToken = IERC20(_symbientToken);
        router = IUniswapV2Router02(_router);
        staking = SymbientStaking(_staking);
        tollyLocker = _tollyLocker;
        treasury = _treasury;
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(KEEPER_ROLE, _admin);
        _grantRole(GOVERNANCE_ROLE, _admin);
    }

    /// @notice Claim accrued creator fees from the Tolly fee locker.
    /// @dev    Gated: forwards arbitrary calldata to the (immutable) locker
    ///         address, so only keepers/admins can call. Claimed USDC lands
    ///         here awaiting routeToTrading().
    function claimFees(bytes calldata data) external onlyRole(KEEPER_ROLE) {
        if (tollyLocker == address(0)) revert ClaimFailed();
        (bool ok,) = tollyLocker.call(data);
        if (!ok) revert ClaimFailed();
        emit FeesClaimed(payoutToken.balanceOf(address(this)));
    }

    /// @notice Consolidate the full USDC balance into the single treasury
    ///         (TRSRY). Permissionless — funds then enter connectome control:
    ///         trading floats are drawn via governor-approved withdrawals, and
    ///         reward funding requires a connectome vote (fundRewards).
    function routeToTreasury() external nonReentrant {
        if (treasury == address(0)) revert NothingToRoute();
        uint256 bal = payoutToken.balanceOf(address(this));
        if (bal == 0) revert NothingToRoute();
        payoutToken.safeTransfer(treasury, bal);
        emit RoutedToTreasury(bal, treasury);
    }

    /// @notice Swap `usdcAmount` of this contract's USDC balance to SYM and
    ///         deposit the proceeds into the staking reward pool.
    /// @dev    GOVERNANCE-gated — this is the connectome decision point. Called
    ///         via GovernorPolicy.executeModule after a connectome vote; the
    ///         GovernorPolicy contract must hold GOVERNANCE_ROLE here.
    function fundRewards(uint256 usdcAmount, uint256 minSymbientOut) external nonReentrant onlyRole(GOVERNANCE_ROLE) {
        uint256 bal = payoutToken.balanceOf(address(this));
        if (usdcAmount > bal) revert NothingToFund();

        payoutToken.forceApprove(address(router), usdcAmount);
        address[] memory path = new address[](2);
        path[0] = address(payoutToken);
        path[1] = address(symbientToken);
        uint256[] memory amounts =
            router.swapExactTokensForTokens(usdcAmount, minSymbientOut, path, address(this), block.timestamp + 300);

        uint256 symbientOut = amounts[amounts.length - 1];
        symbientToken.forceApprove(address(staking), symbientOut);
        staking.depositRewards(symbientOut);

        emit RewardsFunded(usdcAmount, symbientOut, staking.rewardPool());
    }

    function setTreasury(address _treasury) external onlyRole(GOVERNANCE_ROLE) {
        treasury = _treasury;
        emit TreasuryUpdated(_treasury);
    }

    /// @notice Sweep any stray ERC20 — admin only.
    function sweep(address token, address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        IERC20(token).safeTransfer(to, amount);
    }
}

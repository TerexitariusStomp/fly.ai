// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {SymbientCircuitBreaker} from "./SymbientCircuitBreaker.sol";
import {ITreasuryPolicy} from "./ITreasuryPolicy.sol";

/// @title SymbientInverseBond
/// @notice Standing buyback bid for SYM at floorPrice × (1 - spread); received SYM
///         burned (or sent to the dead sink when the token is a non-burnable
///         external launch, e.g. Tolly)
/// @dev The treasury-backing mechanism: SYM can always be sold back to the treasury
///      at the partial-backing floor (RFV per SYM). Prices read live from
///      TreasuryValuation — no manual NAV pushes.
///      - bondPrice = floorPrice × (1 - 1.5%): the guaranteed floor exit
///      - epochCapacity = treasury NAV × maxCapacityBps: limits reserve outflow
///      - Circuit breaker halts sells when SYM-vs-floor monitor trips
///      - `treasury` = the funded float (GovernorPolicy) that approves payoutToken pulls
///      All admin via governor (MULTISIG_ROLE granted to ConnectomeGovernor).
contract SymbientInverseBond is AccessControl {
    bytes32 public constant MULTISIG_ROLE = keccak256("MULTISIG_ROLE");
    error ZeroAddress();

    using SafeERC20 for IERC20;

    error InvalidParams();
    error CapacityExceeded();
    error NothingToBurn();
    error CircuitBreakerTripped();

    address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    IERC20 public immutable symbientToken;
    IERC20 public payoutToken;
    ITreasuryPolicy public valuation;
    uint256 public constant INVERSE_SPREAD_BPS = 150;
    uint256 public constant EPOCH_LENGTH = 8 hours;
    uint256 public constant BASIS_POINTS = 10000;

    /// @dev Per-epoch capacity (bps of treasury NAV). Default 1% (100 bps).
    uint256 public maxCapacityBps = 100;

    /// @dev Circuit breaker — when set, sells halt if it is tripped/paused
    SymbientCircuitBreaker public circuitBreaker;

    /// @dev The funded float that approves payoutToken transfers (GovernorPolicy)
    address public treasury;
    uint256 public epochStartTime;
    uint256 public epochUsedCapacity;

    event InverseBondBurned(address indexed seller, uint256 indexed symbientIn, uint256 indexed payout);
    event EpochReset(uint256 indexed startTime);
    event PayoutTokenUpdated(address indexed oldToken, address indexed newToken);
    event CapacityUpdated(uint256 indexed oldBps, uint256 indexed newBps);
    event CircuitBreakerSet(address indexed breaker);
    event ValuationSet(address indexed valuation);

    constructor(
        address _symbientToken,
        address _payoutToken,
        address _treasury,
        address _valuation,
        address _multisig
    ) AccessControl() {
        _grantRole(DEFAULT_ADMIN_ROLE, _multisig);
        _grantRole(MULTISIG_ROLE, _multisig);
        if (_symbientToken == address(0) || _treasury == address(0) || _payoutToken == address(0) || _valuation == address(0))
            revert ZeroAddress();
        symbientToken = IERC20(_symbientToken);
        payoutToken = IERC20(_payoutToken);
        treasury = _treasury;
        valuation = ITreasuryPolicy(_valuation);
        epochStartTime = block.timestamp;
    }

    /// @notice Buyback price = partial-backing floor × (1 - spread)
    function bondPrice() public view returns (uint256) {
        return (valuation.floorPrice() * (BASIS_POINTS - INVERSE_SPREAD_BPS)) / BASIS_POINTS;
    }

    /// @notice Per-epoch outflow cap = treasury NAV × maxCapacityBps
    function epochCapacity() public view returns (uint256) {
        return (valuation.rfv() * maxCapacityBps) / BASIS_POINTS;
    }

    /// @notice Sell SYM at the backed floor; SYM is burned, payout from treasury float
    function sell(uint256 symbientAmount) external returns (uint256 payout) {
        _resetEpochIfNeeded();

        if (address(circuitBreaker) != address(0) && circuitBreaker.paused())
            revert CircuitBreakerTripped();

        payout = (symbientAmount * bondPrice()) / 1e18;
        if (payout == 0) revert NothingToBurn();
        if (epochUsedCapacity + payout > epochCapacity()) revert CapacityExceeded();

        epochUsedCapacity += payout;

        symbientToken.safeTransferFrom(msg.sender, address(this), symbientAmount);
        // Burn if the token supports it (SymbientToken); otherwise send to the
        // dead sink — same economic effect for a fixed-supply external launch.
        try ERC20Burnable(address(symbientToken)).burn(symbientAmount) {} catch {
            symbientToken.safeTransfer(DEAD_ADDRESS, symbientAmount);
        }

        // slither-disable-next-line arbitrary-send-erc20: treasury is the governor-controlled float. The buyback is the core floor-defense mechanism — seller burns SYM, receives reserves at floor.
        payoutToken.safeTransferFrom(treasury, msg.sender, payout);

        emit InverseBondBurned(msg.sender, symbientAmount, payout);
    }

    function resetEpoch() external {
        _resetEpochIfNeeded();
    }

    function _resetEpochIfNeeded() internal {
        if (block.timestamp >= epochStartTime + EPOCH_LENGTH) {
            epochStartTime = block.timestamp;
            epochUsedCapacity = 0;
            emit EpochReset(epochStartTime);
        }
    }

    function setTreasury(address _treasury) external onlyRole(MULTISIG_ROLE) {
        if (_treasury == address(0)) revert ZeroAddress();
        treasury = _treasury;
    }

    function setPayoutToken(address _newPayoutToken) external onlyRole(MULTISIG_ROLE) {
        if (_newPayoutToken == address(0)) revert ZeroAddress();
        emit PayoutTokenUpdated(address(payoutToken), _newPayoutToken);
        payoutToken = IERC20(_newPayoutToken);
    }

    function setValuation(address _valuation) external onlyRole(MULTISIG_ROLE) {
        if (_valuation == address(0)) revert ZeroAddress();
        valuation = ITreasuryPolicy(_valuation);
        emit ValuationSet(_valuation);
    }

    function setMaxCapacityBps(uint256 _bps) external onlyRole(MULTISIG_ROLE) {
        if (_bps == 0 || _bps > 5000) revert InvalidParams(); // Max 50%
        emit CapacityUpdated(maxCapacityBps, _bps);
        maxCapacityBps = _bps;
    }

    function setCircuitBreaker(address _breaker) external onlyRole(MULTISIG_ROLE) {
        circuitBreaker = SymbientCircuitBreaker(_breaker);
        emit CircuitBreakerSet(_breaker);
    }
}

// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ITokenPriceFeed} from "./ITokenPriceFeed.sol";
import {ITreasuryPolicy} from "./ITreasuryPolicy.sol";

/// @title SymbientCircuitBreaker
/// @notice Global circuit breaker that trips when SYM spot falls below the backed floor
/// @dev Monitors SYM spot price vs TreasuryValuation.floorPrice() (RFV per SYM).
///      If spot < floor × (1 - threshold), pauses — dependent modules check
///      `isOperational()` / `paused()` before operating (inverse bond sells,
///      RBS defense budget, supplemental emissions).
///
///      Design:
///      - Spot below floor by > threshold (default 2%) → pause
///      - Governor/multisig can manually trip/untrip for any reason
///      - Auto-recovery: if spot recovers for `recoveryEpochs` consecutive checks, auto-untrips
///      - Permissionless `check()` for keepers to trigger the breaker
///
///      Read-only oracle — modules must voluntarily check it.
contract SymbientCircuitBreaker is AccessControl, Pausable {
    bytes32 public constant MULTISIG_ROLE = keccak256("MULTISIG_ROLE");
    error ZeroAddress();

    error InvalidThreshold();

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant EPOCH_LENGTH = 8 hours;

    address public symbientToken;
    ITokenPriceFeed public priceFeed;
    ITreasuryPolicy public valuation;

    uint256 public deviationThresholdBps = 200; // 2% below floor
    uint256 public recoveryEpochs = 21; // 21 consecutive good epochs (7 days) to auto-reset
    uint256 public lastCheckTime;
    uint256 public consecutiveGoodEpochs;

    uint256 public tripTime;
    uint256 public tripEpoch;
    uint256 public epochNumber;

    event Tripped(uint256 indexed price, uint256 indexed deviationBps, uint256 indexed timestamp);
    event Untripped(bool indexed autoReset, uint256 indexed consecutiveGoodEpochs);
    event ThresholdUpdated(uint256 indexed thresholdBps);
    event PriceFeedUpdated(address indexed feed);
    event SymbientTokenUpdated(address indexed token);
    event ValuationUpdated(address indexed valuation);

    constructor(address _multisig) AccessControl() {
        _grantRole(DEFAULT_ADMIN_ROLE, _multisig);
        _grantRole(MULTISIG_ROLE, _multisig);
        if (_multisig == address(0)) revert ZeroAddress();
        lastCheckTime = block.timestamp;
    }

    function setSymbientToken(address _token) external onlyRole(MULTISIG_ROLE) {
        if (_token == address(0)) revert ZeroAddress();
        symbientToken = _token;
        emit SymbientTokenUpdated(_token);
    }

    function setPriceFeed(address _feed) external onlyRole(MULTISIG_ROLE) {
        if (_feed == address(0)) revert ZeroAddress();
        priceFeed = ITokenPriceFeed(_feed);
        emit PriceFeedUpdated(_feed);
    }

    function setValuation(address _valuation) external onlyRole(MULTISIG_ROLE) {
        if (_valuation == address(0)) revert ZeroAddress();
        valuation = ITreasuryPolicy(_valuation);
        emit ValuationUpdated(_valuation);
    }

    function setDeviationThreshold(uint256 _bps) external onlyRole(MULTISIG_ROLE) {
        if (_bps == 0 || _bps > 5000) revert InvalidThreshold(); // Max 50%
        deviationThresholdBps = _bps;
        emit ThresholdUpdated(_bps);
    }

    /// @notice Permissionless check — any keeper can call at epoch boundaries
    function check() external {
        if (block.timestamp < lastCheckTime + EPOCH_LENGTH) return;
        if (address(priceFeed) == address(0) || symbientToken == address(0)) return;

        lastCheckTime = block.timestamp;
        ++epochNumber;

        uint256 price = _getPrice(symbientToken);
        if (price == 0) return;

        uint256 floor = _floor();
        if (floor == 0) return;

        // Trip only when spot falls BELOW the backed floor — a premium is fine
        uint256 deviationBps = price < floor ? ((floor - price) * BPS_DENOMINATOR) / floor : 0;

        if (!paused()) {
            if (deviationBps >= deviationThresholdBps) {
                _pause();
                tripTime = block.timestamp;
                tripEpoch = epochNumber;
                consecutiveGoodEpochs = 0;
                emit Tripped(price, deviationBps, block.timestamp);
            }
        } else {
            if (deviationBps < deviationThresholdBps) {
                ++consecutiveGoodEpochs;
                if (consecutiveGoodEpochs >= recoveryEpochs) {
                    _unpause();
                    consecutiveGoodEpochs = 0;
                    emit Untripped(true, recoveryEpochs);
                }
            } else {
                consecutiveGoodEpochs = 0;
            }
        }
    }

    /// @notice Manual trip — governor can trigger for any reason
    function trip() external onlyRole(MULTISIG_ROLE) {
        _pause();
        tripTime = block.timestamp;
        tripEpoch = epochNumber;
        consecutiveGoodEpochs = 0;
        emit Tripped(0, 0, block.timestamp);
    }

    /// @notice Manual untrip — governor can reset
    function untrip() external onlyRole(MULTISIG_ROLE) {
        _unpause();
        consecutiveGoodEpochs = 0;
        emit Untripped(false, 0);
    }

    /// @notice View: should a module allow operations?
    function isOperational() external view returns (bool) {
        return !paused();
    }

    /// @notice View: current deviation below floor in bps (0 if at/above floor)
    function currentDeviationBps() external view returns (uint256) {
        if (address(priceFeed) == address(0) || symbientToken == address(0)) return 0;
        uint256 price = _getPrice(symbientToken);
        uint256 floor = _floor();
        if (price == 0 || floor == 0) return 0;
        return price < floor ? ((floor - price) * BPS_DENOMINATOR) / floor : 0;
    }

    function _floor() internal view returns (uint256) {
        if (address(valuation) == address(0)) return 0;
        try valuation.floorPrice() returns (uint256 f) {
            return f;
        } catch {
            return 0;
        }
    }

    function _getPrice(address token) internal view returns (uint256) {
        if (address(priceFeed) == address(0)) return 0;
        try priceFeed.getTokenPrice(token) returns (uint256 price) {
            return price;
        } catch {
            return 0;
        }
    }
}

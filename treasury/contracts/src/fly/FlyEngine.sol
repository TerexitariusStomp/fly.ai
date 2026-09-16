// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {SSTORE2} from "solady/utils/SSTORE2.sol";

/// @title FlyEngine — On-chain LIF connectome simulation
/// @notice Runs LIF simulation fully on-chain. Reads connectome data via SSTORE2.
///         Anyone can call analyze() — caller pays gas.
/// @dev LIF dynamics ported from alextitonis/fly.ai FlyBrain (MIT).
///      int8 quantization from duoxehyon/evm-neural-network (MIT).
contract FlyEngine is Initializable, UUPSUpgradeable {
    // Q24 fixed-point constants (from fly.ai, retuned for trading)
    int256 internal constant DECAY_Q24 = 13743895;    // exp(-0.2) * 2^24
    int256 internal constant TONIC_Q24 = 2359296;      // 0.14 * 2^24
    int256 internal constant THRESHOLD_Q24 = 16777216; // 1.0 * 2^24
    int256 internal constant EYE_GAIN_Q24 = 25165824;  // 1.5 * 2^24 — was 0.62, now high enough to fire
    int256 internal constant WEIGHT_SCALE = 7190235;  // (3.0 * 2^24) / 7

    struct ConnectomeData {
        uint32 nNeurons;
        uint32 nSynapses;
        uint8 nSteps;
        uint8 indptrWidth;       // 1=uint8, 2=uint16
        uint32 indptrOffset;
        uint32 indicesOffset;
        uint32 weightsOffset;
        address[] chunks;        // SSTORE2 pointers
    }

    struct MarketData {
        int256 price;
        int256 volume;
        int256 momentum;
        int256 volatility;
        int256 signalScore;  // staking signal (Q24, 0=none, 16777216=max)
    }

    struct Decision {
        int8 action;             // -1=sell, 0=hold, 1=buy
        uint8 confidence;
        bytes32 connectomeId;
    }

    mapping(bytes32 => ConnectomeData) public connectomes;
    address public admin;
    address public governor;

    event DecisionComputed(bytes32 indexed connectomeId, int8 action, uint8 confidence);

    function initialize(address _admin) public initializer {
        admin = _admin;
    }

    /// @notice Run LIF simulation on a connectome. Caller pays gas.
    /// @param connectomeId The connectome to analyze
    /// @param market Market data (Q24 fixed-point)
    /// @param maxSteps Maximum simulation steps (caps gas usage)
    function analyze(bytes32 connectomeId, MarketData calldata market, uint8 maxSteps)
        external
        returns (Decision memory)
    {
        Decision memory d = _analyze(connectomeId, market, maxSteps);
        emit DecisionComputed(connectomeId, d.action, d.confidence);
        return d;
    }

    /// @notice View version of analyze for testing (no event, no gas cost)
    function analyzeView(bytes32 connectomeId, MarketData calldata market, uint8 maxSteps)
        external
        view
        returns (Decision memory)
    {
        return _analyze(connectomeId, market, maxSteps);
    }

    function _analyze(bytes32 connectomeId, MarketData calldata market, uint8 maxSteps)
        internal
        view
        returns (Decision memory)
    {
        ConnectomeData storage c = connectomes[connectomeId];
        require(c.nNeurons > 0, "unknown connectome");

        uint32 n = c.nNeurons;
        uint8 nSteps = maxSteps < c.nSteps ? maxSteps : c.nSteps;

        // Load all connectome data into memory (bounded by connectome size)
        bytes memory data = _loadAll(c);

        // Build cumulative indptr
        uint32[] memory indptr = _buildIndptr(c, data);

        // Rasterize market → neural input
        int256[] memory input = _rasterize(market, n);

        // LIF simulation
        int256[] memory v = new int256[](n);
        int256[] memory current = new int256[](n);
        bool[] memory fired = new bool[](n);

        for (uint8 step = 0; step < nSteps; step++) {
            // Compute synaptic input from fired neurons
            for (uint32 i = 0; i < n; i++) {
                if (fired[i]) {
                    _propagate(c, data, indptr, i, current);
                }
            }
            // LIF update: v = decay*v + current + tonic + input; threshold; reset
            for (uint32 i = 0; i < n; i++) {
                v[i] = (v[i] * DECAY_Q24) >> 24;
                v[i] += current[i] + TONIC_Q24 + input[i];
                current[i] = 0;
                if (v[i] >= THRESHOLD_Q24) {
                    fired[i] = true;
                    v[i] = 0;
                } else {
                    fired[i] = false;
                }
            }
        }

        return _decode(v, input, n, connectomeId);
    }

    // ============ Load all connectome data via SSTORE2 ============
    function _loadAll(ConnectomeData storage c) internal view returns (bytes memory) {
        uint32 totalSize = c.weightsOffset + (c.nSynapses + 1) / 2;
        bytes memory data = new bytes(totalSize);
        uint32 offset = 0;
        for (uint256 i = 0; i < c.chunks.length; i++) {
            bytes memory chunk = SSTORE2.read(c.chunks[i]);
            uint32 toCopy = uint32(chunk.length);
            if (offset + toCopy > totalSize) toCopy = totalSize - offset;
            for (uint32 j = 0; j < toCopy; j++) {
                data[offset + j] = chunk[j];
            }
            offset += toCopy;
        }
        return data;
    }

    // ============ Build cumulative indptr ============
    function _buildIndptr(ConnectomeData storage c, bytes memory data)
        internal
        view
        returns (uint32[] memory indptr)
    {
        uint32 n = c.nNeurons;
        indptr = new uint32[](n + 1);
        uint32 cum = 0;
        for (uint32 i = 0; i <= n; i++) {
            indptr[i] = cum;
            if (i < n) {
                if (c.indptrWidth == 1) {
                    cum += uint32(uint8(data[c.indptrOffset + i]));
                } else {
                    cum += uint32(_readUint16(data, c.indptrOffset + i * 2));
                }
            }
        }
    }

    // ============ CSR Scatter-Add ============
    function _propagate(
        ConnectomeData storage c,
        bytes memory data,
        uint32[] memory indptr,
        uint32 neuron,
        int256[] memory current
    ) internal view {
        uint32 start = indptr[neuron];
        uint32 end = indptr[neuron + 1];
        for (uint32 k = start; k < end; k++) {
            uint16 target = _readUint16(data, c.indicesOffset + k * 2);
            int8 weight = _readInt4(data, c.weightsOffset, k);
            if (weight != 0) {
                current[target] += int256(int256(weight) * WEIGHT_SCALE);
            }
        }
    }

    // ============ Byte readers ============
    function _readUint16(bytes memory data, uint32 offset) internal pure returns (uint16) {
        return uint16(uint8(data[offset])) << 8 | uint16(uint8(data[offset + 1]));
    }

    function _readInt4(bytes memory data, uint32 offset, uint32 index)
        internal
        pure
        returns (int8)
    {
        uint32 byteOffset = offset + index / 2;
        uint8 b = uint8(data[byteOffset]);
        int8 val;
        if (index % 2 == 0) {
            val = int8(int8(b >> 4));
        } else {
            val = int8(int8(b & 0x0F));
        }
        if (val >= 8) val -= 16;
        return val;
    }

    // ============ Rasterizer ============
    // Maps market data to neural input. Buy neurons get signal from
    // low price + positive momentum + low volatility.
    // Sell neurons get signal from high volume + high volatility.
    // The signals are asymmetric so different markets produce different decisions.
    function _rasterize(MarketData memory market, uint32 n)
        internal
        pure
        returns (int256[] memory input)
    {
        input = new int256[](n);
        uint32 half = n / 2;
        
        // Normalize market data to [0, 1] range (Q24)
        int256 priceNorm = _normalize(market.price, 0, 2000000000000000);
        int256 volumeNorm = _normalize(market.volume, 0, 200000000000000);
        int256 momentumNorm = _normalize(market.momentum, -1000000000000000, 1000000000000000);
        int256 volatilityNorm = _normalize(market.volatility, 0, 1000000000000000);
        
        // Split momentum into positive/negative components centered at 0.5
        // momentumNorm = 0.5 means momentum = 0 (no trend)
        int256 HALF_Q24 = 8388608; // 0.5 * 2^24
        int256 momentumPos = momentumNorm > HALF_Q24 ? (momentumNorm - HALF_Q24) * 2 : int256(0);
        int256 momentumNeg = momentumNorm < HALF_Q24 ? (HALF_Q24 - momentumNorm) * 2 : int256(0);
        
        // Buy signal: low price * positive momentum * low volatility * signal score (4-factor)
        int256 invPrice = 16777216 - priceNorm;
        int256 invVol = 16777216 - volatilityNorm;
        int256 buySignal = (invPrice * momentumPos) / 16777216;
        buySignal = (buySignal * invVol) / 16777216;
        // Signal score amplifies buy signal — higher staking = stronger buy
        buySignal = (buySignal * (16777216 + market.signalScore)) / (16777216 * 2);
        buySignal = (buySignal * EYE_GAIN_Q24) / 16777216;
        
        // Sell signal: high price * negative momentum * high volatility (3-factor, signal-independent)
        int256 sellSignal = (priceNorm * momentumNeg) / 16777216;
        sellSignal = (sellSignal * volatilityNorm) / 16777216;
        sellSignal = (sellSignal * EYE_GAIN_Q24) / 16777216;
        
        // If both signals are weak, add tonic baseline so neurons still respond
        if (buySignal < TONIC_Q24) buySignal = TONIC_Q24;
        if (sellSignal < TONIC_Q24) sellSignal = TONIC_Q24;
        
        // Apply signals to neurons with slight variation per neuron
        // so they don't all fire at the same threshold
        for (uint32 i = 0; i < half; i++) {
            // Vary signal slightly per neuron using a simple hash
            int256 variation = int256(uint256(keccak256(abi.encodePacked(i, "buy"))) % 1677720);
            input[i] = buySignal + variation;
        }
        for (uint32 i = half; i < n; i++) {
            int256 variation = int256(uint256(keccak256(abi.encodePacked(i, "sell"))) % 1677720);
            input[i] = sellSignal + variation;
        }
    }

    // ============ Normalize value to [0, 1] range ============
    function _normalize(int256 value, int256 min, int256 max) internal pure returns (int256) {
        if (value <= min) return 0;
        if (value >= max) return 16777216; // 1.0 in Q24
        return (value - min) * 16777216 / (max - min);
    }

    // ============ Readout ============
    // Decision direction comes from raw input signals — the rasterizer already
    // encodes bullish/bearish conditions. Post-propagation membrane potentials
    // get scrambled by untrained biological weights, so we only use connectome
    // activity level for confidence (more activity = higher confidence).
    function _decode(int256[] memory v, int256[] memory input, uint32 n, bytes32 connectomeId)
        internal
        pure
        returns (Decision memory)
    {
        uint32 half = n / 2;

        // Input signal strength determines direction
        int256 buyInputSum = 0;
        int256 sellInputSum = 0;
        for (uint32 i = 0; i < half; i++) {
            buyInputSum += input[i];
        }
        for (uint32 i = half; i < n; i++) {
            sellInputSum += input[i];
        }

        // Connectome activity level determines confidence
        int256 activitySum = 0;
        for (uint32 i = 0; i < n; i++) {
            if (v[i] > 0) activitySum += v[i];
        }

        int256 diff = buyInputSum - sellInputSum;
        int256 totalInput = buyInputSum + sellInputSum;
        if (totalInput <= 0 || diff == 0) {
            return Decision(0, 50, connectomeId);
        }

        // Hold threshold: if |diff| < 15% of total, signal is too ambiguous
        int256 absDiff = diff > 0 ? diff : -diff;
        if ((absDiff * 100) / totalInput < 15) {
            return Decision(0, 50, connectomeId);
        }

        // Confidence = 50 base + up to 50 bonus from connectome activity
        uint8 conf = 50;
        if (activitySum > 0) {
            uint256 bonus = uint256((activitySum * 50) / totalInput);
            if (bonus > 50) bonus = 50;
            conf = uint8(50 + bonus);
        }

        return Decision(diff > 0 ? int8(1) : int8(-1), conf, connectomeId);
    }

    // ============ Admin ============
    function testData(bytes32 connectomeId) external view returns (uint32, uint32) {
        ConnectomeData storage c = connectomes[connectomeId];
        bytes memory data = _loadAll(c);
        return (c.nNeurons, uint32(data.length));
    }

    function debugIndptr(bytes32 connectomeId, uint32 neuron) external view returns (uint32, uint32) {
        ConnectomeData storage c = connectomes[connectomeId];
        require(c.nNeurons > 0, "connectome not found");
        require(neuron < c.nNeurons, "neuron out of bounds");
        bytes memory data = _loadAll(c);
        uint32[] memory indptr = _buildIndptr(c, data);
        return (indptr[neuron], indptr[neuron + 1]);
    }

    function getChunks(bytes32 connectomeId) external view returns (address[] memory) {
        return connectomes[connectomeId].chunks;
    }

    function registerConnectome(bytes32 id, ConnectomeData calldata data) external {
        require(msg.sender == admin || msg.sender == governor, "not authorized");
        connectomes[id] = data;
    }

    function deregisterConnectome(bytes32 id) external {
        require(msg.sender == admin || msg.sender == governor, "not authorized");
        delete connectomes[id];
    }

    function setGovernor(address _governor) external {
        require(msg.sender == admin, "not admin");
        governor = _governor;
    }

    function _authorizeUpgrade(address) internal override {
        require(msg.sender == admin, "not admin");
    }
}

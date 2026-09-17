// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

interface IFlyEngine {
    struct MarketData {
        int256 price;
        int256 volume;
        int256 momentum;
        int256 volatility;
        int256 signalScore;
    }
    struct Decision {
        int8 action;
        uint8 confidence;
        bytes32 connectomeId;
    }
    function analyze(bytes32 connectomeId, MarketData calldata market, uint8 maxSteps) external returns (Decision memory);
}

interface IConnectomeGovernor {
    function vote(bytes32 proposalId, bytes32 connectomeId) external returns (bool);
}

/// @title DecisionRelayEngine — off-chain inference → on-chain vote bridge
/// @notice Connectome neural decisions are computed off-chain (fly-brain DOs)
///         and pushed on-chain by each connectome's bound voter key. This
///         contract implements IFlyEngine so ConnectomeGovernor.vote() reads
///         the just-set decision via analyze(). Atomic: castVote sets the
///         decision and calls vote() in one transaction — if the vote reverts,
///         the pending decision rolls back with it.
contract DecisionRelayEngine {
    address public admin;

    /// @notice Connectome id → the EOA authorized to cast its votes
    mapping(bytes32 => address) public voterOf;

    /// @notice Connectome id → pending decision consumed by the next analyze()
    mapping(bytes32 => IFlyEngine.Decision) public pending;

    event DecisionSet(bytes32 indexed connectomeId, int8 action, uint8 confidence);
    event VoterBound(bytes32 indexed connectomeId, address voter);

    modifier onlyAdmin() {
        require(msg.sender == admin, "not admin");
        _;
    }

    constructor() {
        admin = msg.sender;
    }

    function setAdmin(address a) external onlyAdmin {
        admin = a;
    }

    function setVoter(bytes32 connectomeId, address voter) external onlyAdmin {
        voterOf[connectomeId] = voter;
        emit VoterBound(connectomeId, voter);
    }

    /// @notice Push an off-chain decision and vote in one tx.
    ///         msg.sender must be the connectome's bound voter; this contract
    ///         must be registered as the connectome's voter on the governor.
    function castVote(address governor, bytes32 proposalId, bytes32 connectomeId, int8 action, uint8 confidence)
        external
        returns (bool)
    {
        require(msg.sender == voterOf[connectomeId], "not connectome voter");
        pending[connectomeId] = IFlyEngine.Decision(action, confidence, connectomeId);
        emit DecisionSet(connectomeId, action, confidence);
        return IConnectomeGovernor(governor).vote(proposalId, connectomeId);
    }

    /// @notice Called by the governor inside vote(). Returns and clears the
    ///         pending decision so a stale decision can never be replayed onto
    ///         a different proposal. Unset → abstain.
    function analyze(bytes32 connectomeId, IFlyEngine.MarketData calldata, uint8)
        external
        returns (IFlyEngine.Decision memory d)
    {
        d = pending[connectomeId];
        delete pending[connectomeId];
        if (d.connectomeId == bytes32(0)) {
            d = IFlyEngine.Decision(0, 0, connectomeId);
        }
    }

    /// @notice View twin of analyze — does not consume.
    function analyzeView(bytes32 connectomeId, IFlyEngine.MarketData calldata, uint8)
        external
        view
        returns (IFlyEngine.Decision memory d)
    {
        d = pending[connectomeId];
        if (d.connectomeId == bytes32(0)) {
            d = IFlyEngine.Decision(0, 0, connectomeId);
        }
    }
}

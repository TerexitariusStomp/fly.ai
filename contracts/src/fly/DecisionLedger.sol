// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

/// @title DecisionLedger — On-chain audit trail for all connectome decisions
/// @notice Every connectome decision, vote, and execution is recorded as an event.
///         This surpasses DeepWorm (which only verifies computation, not reasoning context).
///         Anyone can query the full decision history of any connectome.
contract DecisionLedger {
    // ============ Events (zero-cost audit trail via logs) ============
    event DecisionRecorded(
        bytes32 indexed connectomeId,
        bytes32 indexed proposalId,
        int8 action,           // -1=sell, 0=hold, 1=buy
        uint8 confidence,       // 0-100
        bytes32 marketHash,     // hash of market context
        int256 signalScore,     // staking signal at time of decision
        uint256 timestamp,
        bool executed           // whether this decision led to execution
    );

    event VoteRecorded(
        bytes32 indexed proposalId,
        bytes32 indexed connectomeId,
        uint8 confidence,       // connectome confidence at vote time
        uint256 voteWeight,     // effective vote weight
        uint256 timestamp
    );

    event ExecutionRecorded(
        bytes32 indexed proposalId,
        bytes32 indexed action,
        address indexed executor,
        uint256 timestamp,
        bool success
    );

    // ============ Counters (queryable) ============
    mapping(bytes32 => uint256) public decisionCount;      // connectomeId => count
    mapping(bytes32 => uint256) public proposalVoteCount;   // proposalId => votes
    mapping(bytes32 => bool) public proposalExecuted;       // proposalId => executed

    address public governor;
    address public admin;

    modifier onlyGovernor() {
        require(msg.sender == governor || msg.sender == admin, "not authorized");
        _;
    }

    constructor(address _admin) {
        admin = _admin;
    }

    function setGovernor(address _governor) external {
        require(msg.sender == admin, "not admin");
        governor = _governor;
    }

    /// @notice Record a connectome's decision (after LIF analysis)
    function recordDecision(
        bytes32 connectomeId,
        bytes32 proposalId,
        int8 action,
        uint8 confidence,
        bytes32 marketHash,
        int256 signalScore,
        bool executed
    ) external onlyGovernor {
        decisionCount[connectomeId]++;
        emit DecisionRecorded(
            connectomeId, proposalId, action, confidence,
            marketHash, signalScore, block.timestamp, executed
        );
    }

    /// @notice Record a vote on a proposal
    function recordVote(
        bytes32 proposalId,
        bytes32 connectomeId,
        uint8 confidence,
        uint256 voteWeight
    ) external onlyGovernor {
        proposalVoteCount[proposalId]++;
        emit VoteRecorded(proposalId, connectomeId, confidence, voteWeight, block.timestamp);
    }

    /// @notice Record execution of a proposal
    function recordExecution(
        bytes32 proposalId,
        bytes32 action,
        address executor,
        bool success
    ) external onlyGovernor {
        proposalExecuted[proposalId] = true;
        emit ExecutionRecorded(proposalId, action, executor, block.timestamp, success);
    }

    // ============ View Functions ============
    function getDecisionCount(bytes32 connectomeId) external view returns (uint256) {
        return decisionCount[connectomeId];
    }

    function getVoteCount(bytes32 proposalId) external view returns (uint256) {
        return proposalVoteCount[proposalId];
    }

    function wasExecuted(bytes32 proposalId) external view returns (bool) {
        return proposalExecuted[proposalId];
    }
}

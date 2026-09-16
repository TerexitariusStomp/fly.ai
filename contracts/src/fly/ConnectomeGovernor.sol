// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

/// @title FlyEngine interface for calling analyze()
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

interface ISocialPostLog {
    function post(bytes32 connectomeId, uint8 postType, string calldata content) external;
}

interface IDecisionLedger {
    function recordVote(bytes32 proposalId, bytes32 connectomeId, uint8 confidence, uint256 voteWeight) external;
    function recordExecution(bytes32 proposalId, bytes32 action, address executor, bool success) external;
}

/// @title ConnectomeGovernor — Minimal connectome-consensus executor
/// @notice Connectomes operate the entire protocol through this contract.
///         A proposal is (target, calldata, market context). Each connectome
///         votes by running FlyEngine.analyze() on the market context:
///         action +1 = for, -1 = against, 0 = abstain.
///         Pass = forVotes >= quorum (default ceil(1/3 of connectomes))
///         AND forVotes > againstVotes. Anyone can then execute.
///         This contract is the kernel executor and holds all protocol roles.
contract ConnectomeGovernor is Initializable, UUPSUpgradeable {
    struct Proposal {
        address target;
        bytes data;
        IFlyEngine.MarketData market;
        uint256 deadline;
        uint256 forVotes;
        uint256 againstVotes;
        uint256 forWeight;        // confidence-weighted for votes
        bool executed;
        mapping(bytes32 => bool) voted;
    }

    // ============ Storage ============
    address public admin;
    IFlyEngine public flyEngine;
    address public decisionLedger;
    /// @notice On-chain log the ICP canister follows; each execution emits a
    ///         SocialPost event the connectomes turn into social content.
    address public socialPostLog;

    bytes32[] public connectomeIds;
    mapping(bytes32 => bool) public isConnectome;
    /// @dev Optional: bind a connectome's vote to a specific EOA. If set, only
    ///      that address can trigger the vote. If unset, vote() is permissionless
    ///      (inference is deterministic — triggering is just gas).
    mapping(bytes32 => address) public connectomeVoters;

    mapping(bytes32 => Proposal) public proposals;
    bytes32[] public proposalIds;
    mapping(bytes32 => bool) public vetoed;

    uint256 public quorumBps;            // default 3334 (~1/3)
    uint256 public proposalLifetime;     // default 7 days
    uint8 public maxSteps;               // LIF sim cap for votes
    bool public confidenceWeightedVoting;
    uint256 public weightThreshold;      // required forWeight when enabled (0 = use count quorum)

    event ProposalCreated(bytes32 indexed proposalId, address indexed target, bytes data, uint256 deadline);
    event VoteCast(bytes32 indexed proposalId, bytes32 indexed connectomeId, int8 direction, uint8 confidence);
    event ProposalExecuted(bytes32 indexed proposalId, address indexed target);
    event ProposalVetoed(bytes32 indexed proposalId, address indexed admin);
    event ConnectomeAdded(bytes32 indexed connectomeId);
    event ConnectomeRemoved(bytes32 indexed connectomeId);
    event VoterBound(bytes32 indexed connectomeId, address indexed voter);

    modifier onlyAdmin() {
        require(msg.sender == admin, "not admin");
        _;
    }

    function initialize(address _admin, address _flyEngine) public initializer {
        admin = _admin;
        flyEngine = IFlyEngine(_flyEngine);
        quorumBps = 3334;
        proposalLifetime = 7 days;
        maxSteps = 64;
    }

    // ============ Proposals ============

    /// @notice Create a governance proposal. Permissionless — the connectome
    ///         votes decide whether it executes.
    function propose(
        address target,
        bytes calldata data,
        IFlyEngine.MarketData calldata market
    ) external returns (bytes32 proposalId) {
        require(target != address(0), "zero target");
        proposalId = keccak256(abi.encode(target, data, market, block.timestamp, proposalIds.length));

        Proposal storage p = proposals[proposalId];
        p.target = target;
        p.data = data;
        p.market = market;
        p.deadline = block.timestamp + proposalLifetime;

        proposalIds.push(proposalId);
        emit ProposalCreated(proposalId, target, data, p.deadline);
    }

    /// @notice Cast a connectome's vote. Runs the connectome's LIF inference on
    ///         the proposal's market context; the decision direction is the vote.
    function vote(bytes32 proposalId, bytes32 connectomeId) external returns (bool passed) {
        Proposal storage p = proposals[proposalId];
        require(p.target != address(0), "proposal not found");
        require(!p.executed, "already executed");
        require(!vetoed[proposalId], "vetoed");
        require(block.timestamp <= p.deadline, "proposal expired");
        require(isConnectome[connectomeId], "not a connectome");
        require(!p.voted[connectomeId], "already voted");
        address voter = connectomeVoters[connectomeId];
        require(voter == address(0) || msg.sender == voter, "not connectome voter");

        IFlyEngine.Decision memory d = flyEngine.analyze(connectomeId, p.market, maxSteps);
        p.voted[connectomeId] = true;

        if (d.action > 0) {
            p.forVotes++;
            p.forWeight += d.confidence;
        } else if (d.action < 0) {
            p.againstVotes++;
        }
        // action == 0 → abstain

        emit VoteCast(proposalId, connectomeId, d.action, d.confidence);
        if (decisionLedger != address(0)) {
            IDecisionLedger(decisionLedger).recordVote(proposalId, connectomeId, d.confidence, d.confidence);
        }
        return _passed(p);
    }

    /// @notice Execute a passed proposal. Permissionless.
    function execute(bytes32 proposalId) external returns (bytes memory result) {
        Proposal storage p = proposals[proposalId];
        require(p.target != address(0), "proposal not found");
        require(!p.executed, "already executed");
        require(!vetoed[proposalId], "vetoed");
        require(block.timestamp <= p.deadline, "proposal expired");
        require(_passed(p), "quorum not reached");

        p.executed = true;
        (bool ok, bytes memory res) = p.target.call(p.data);
        if (decisionLedger != address(0)) {
            IDecisionLedger(decisionLedger).recordExecution(proposalId, bytes32(0), msg.sender, ok);
        }
        require(ok, "call failed");
        emit ProposalExecuted(proposalId, p.target);
        if (socialPostLog != address(0)) {
            // postType 2 = governance execution; proposal id as the "connectome"
            // is the group identity (the colony acting as one)
            try ISocialPostLog(socialPostLog).post(
                proposalId, 2, "connectome-governance-action-executed"
            ) {} catch {}
        }
        return res;
    }

    function _passed(Proposal storage p) internal view returns (bool) {
        uint256 q = _quorum();
        if (p.forVotes < q || p.forVotes <= p.againstVotes) return false;
        if (confidenceWeightedVoting && weightThreshold > 0 && p.forWeight < weightThreshold) return false;
        return true;
    }

    function _quorum() internal view returns (uint256) {
        uint256 n = connectomeIds.length;
        if (n == 0) return 1;
        return (n * quorumBps + 9999) / 10000;
    }

    function quorum() external view returns (uint256) { return _quorum(); }

    // ============ Views ============

    function getProposal(bytes32 proposalId) external view returns (
        address target, bytes memory data, uint256 deadline,
        uint256 forVotes, uint256 againstVotes, bool executed
    ) {
        Proposal storage p = proposals[proposalId];
        return (p.target, p.data, p.deadline, p.forVotes, p.againstVotes, p.executed);
    }

    function hasVoted(bytes32 proposalId, bytes32 connectomeId) external view returns (bool) {
        return proposals[proposalId].voted[connectomeId];
    }

    function isPassed(bytes32 proposalId) external view returns (bool) {
        return _passed(proposals[proposalId]);
    }

    function getProposalIds() external view returns (bytes32[] memory) { return proposalIds; }
    function getConnectomeIds() external view returns (bytes32[] memory) { return connectomeIds; }
    function connectomeCount() external view returns (uint256) { return connectomeIds.length; }

    // ============ Admin ============

    function addConnectome(bytes32 connectomeId, address voter) external onlyAdmin {
        require(!isConnectome[connectomeId], "already registered");
        isConnectome[connectomeId] = true;
        connectomeIds.push(connectomeId);
        connectomeVoters[connectomeId] = voter;
        emit ConnectomeAdded(connectomeId);
        emit VoterBound(connectomeId, voter);
    }

    function removeConnectome(bytes32 connectomeId) external onlyAdmin {
        require(isConnectome[connectomeId], "not a connectome");
        isConnectome[connectomeId] = false;
        delete connectomeVoters[connectomeId];
        for (uint256 i = 0; i < connectomeIds.length; i++) {
            if (connectomeIds[i] == connectomeId) {
                connectomeIds[i] = connectomeIds[connectomeIds.length - 1];
                connectomeIds.pop();
                break;
            }
        }
        emit ConnectomeRemoved(connectomeId);
    }

    function setConnectomeVoter(bytes32 connectomeId, address voter) external onlyAdmin {
        require(isConnectome[connectomeId], "not a connectome");
        connectomeVoters[connectomeId] = voter;
        emit VoterBound(connectomeId, voter);
    }

    /// @notice Veto an open proposal. Backstop only — blocks execution.
    function vetoProposal(bytes32 proposalId) external onlyAdmin {
        require(proposals[proposalId].target != address(0), "proposal not found");
        require(!proposals[proposalId].executed, "already executed");
        require(!vetoed[proposalId], "already vetoed");
        vetoed[proposalId] = true;
        emit ProposalVetoed(proposalId, msg.sender);
    }

    function setFlyEngine(address _flyEngine) external onlyAdmin { flyEngine = IFlyEngine(_flyEngine); }
    function setDecisionLedger(address _ledger) external onlyAdmin { decisionLedger = _ledger; }
    function setSocialPostLog(address _log) external onlyAdmin { socialPostLog = _log; }
    function setQuorumBps(uint256 bps) external onlyAdmin { require(bps > 0 && bps <= 10000, "bad quorum"); quorumBps = bps; }
    function setProposalLifetime(uint256 secs) external onlyAdmin { proposalLifetime = secs; }
    function setMaxSteps(uint8 steps) external onlyAdmin { maxSteps = steps; }
    function setConfidenceWeightedVoting(bool enabled) external onlyAdmin { confidenceWeightedVoting = enabled; }
    function setWeightThreshold(uint256 w) external onlyAdmin { weightThreshold = w; }

    function _authorizeUpgrade(address) internal override onlyAdmin {}

    receive() external payable {}
}

// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

/// @title SocialPostLog — on-chain event log the ICP connectome canister
///        follows via eth_getLogs. Each emitted event is picked up by the
///        canister, which generates connectome-voiced content (LLM) and posts
///        it to Bluesky/ATProto + the Git journal.
contract SocialPostLog {
    event SocialPost(
        bytes32 indexed connectomeId,
        uint8 postType,
        string content,
        uint256 timestamp,
        uint256 blockNumber
    );

    address public admin;
    address public governor;

    constructor(address _admin) {
        admin = _admin;
    }

    function setGovernor(address _governor) external {
        require(msg.sender == admin, "not admin");
        governor = _governor;
    }

    function post(bytes32 connectomeId, uint8 postType, string calldata content) external {
        require(msg.sender == governor || msg.sender == admin, "not authorized");
        emit SocialPost(connectomeId, postType, content, block.timestamp, block.number);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Non-custodial tamper-evidence prototype. Stores commitments only.
contract TrustBridgeEventAnchor {
    address public owner;
    mapping(address => bool) public writers;
    mapping(bytes32 => bytes32) private eventHashes;

    error Unauthorized();
    error InvalidValue();
    error IdempotencyConflict();

    event WriterUpdated(address indexed writer, bool enabled);
    event EventAnchored(bytes32 indexed operationKey, bytes32 indexed eventHash, address indexed submitter);

    constructor() {
        owner = msg.sender;
        writers[msg.sender] = true;
        emit WriterUpdated(msg.sender, true);
    }

    function setWriter(address writer, bool enabled) external {
        if (msg.sender != owner) revert Unauthorized();
        if (writer == address(0)) revert InvalidValue();
        writers[writer] = enabled;
        emit WriterUpdated(writer, enabled);
    }

    function anchor(bytes32 operationKey, bytes32 eventHash) external {
        if (!writers[msg.sender]) revert Unauthorized();
        if (operationKey == bytes32(0) || eventHash == bytes32(0)) revert InvalidValue();
        bytes32 existing = eventHashes[operationKey];
        if (existing != bytes32(0) && existing != eventHash) revert IdempotencyConflict();
        if (existing == bytes32(0)) eventHashes[operationKey] = eventHash;
        emit EventAnchored(operationKey, eventHash, msg.sender);
    }

    function getEventHash(bytes32 operationKey) external view returns (bytes32) {
        return eventHashes[operationKey];
    }
}

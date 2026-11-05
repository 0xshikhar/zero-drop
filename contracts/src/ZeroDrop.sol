// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IDisclosureVerifier} from "./IDisclosureVerifier.sol";

/// @notice Early contract foundation. Frame-transaction validation is not implemented yet.
/// @dev This contract deliberately does not claim EIP-8141 compatibility until its
///      frame opcode path is implemented and exercised against the target devnet.
contract ZeroDrop {
    error NotIssuer();
    error InvalidGroup();
    error InvalidCommitment();
    error InvalidVerifier();
    error VerifierLocked();
    error InvalidRecord();

    struct Group {
        address issuer;
        uint32 size;
        uint32 minSize;
        uint256 root;
    }

    struct Record {
        uint256 groupId;
        bytes32 caseId;
        uint256 root;
        uint256 nullifier;
        uint64 blockNumber;
        bool exists;
    }

    uint256 public nextGroupId = 1;
    mapping(uint256 groupId => Group) public groups;
    mapping(uint256 groupId => mapping(uint256 root => bool)) public knownRoot;
    mapping(uint256 groupId => mapping(uint256 index => uint256 commitment)) public members;
    mapping(bytes32 cidDigest => Record) public records;
    mapping(address => bool) public hasPosted;

    IDisclosureVerifier public verifier;
    bool public verifierLocked;
    address public immutable owner;

    event GroupCreated(uint256 indexed groupId, address indexed issuer, uint32 minSize);
    event MembersAdded(uint256 indexed groupId, uint32 newSize, uint256 indexed root);
    event Disclosed(
        bytes32 indexed cidDigest,
        uint256 indexed groupId,
        bytes32 indexed caseId,
        uint256 root,
        uint256 nullifier
    );
    event VerifierChanged(address indexed verifier);
    event VerifierLockedEvent();

    constructor(address verifier_) {
        owner = msg.sender;
        if (verifier_ != address(0)) verifier = IDisclosureVerifier(verifier_);
    }

    function createGroup(uint32 minSize) external returns (uint256 groupId) {
        if (minSize == 0) revert InvalidGroup();
        groupId = nextGroupId++;
        groups[groupId] = Group({issuer: msg.sender, size: 0, minSize: minSize, root: 0});
        knownRoot[groupId][0] = true;
        emit GroupCreated(groupId, msg.sender, minSize);
    }

    /// @notice Issuer adds commitments handed over out of band by members.
    /// @dev Temporary deterministic accumulator; replace with the agreed LeanIMT before ZK.
    function addMembers(uint256 groupId, uint256[] calldata commitments) external {
        Group storage group = groups[groupId];
        if (group.issuer == address(0)) revert InvalidGroup();
        if (msg.sender != group.issuer) revert NotIssuer();
        if (commitments.length == 0 || commitments.length > type(uint32).max - group.size) {
            revert InvalidCommitment();
        }

        uint256 root = group.root;
        for (uint256 i; i < commitments.length; ++i) {
            uint256 commitment = commitments[i];
            if (commitment == 0) revert InvalidCommitment();
            members[groupId][group.size + i] = commitment;
            root = uint256(keccak256(abi.encode(root, commitment)));
        }

        group.size += uint32(commitments.length);
        group.root = root;
        knownRoot[groupId][root] = true;
        emit MembersAdded(groupId, group.size, root);
    }

    /// @notice Development-only direct record path, not an anonymous posting path.
    /// @dev `hasPosted` prevents an address from posting twice but links the caller onchain.
    function record(
        uint256 groupId,
        bytes32 caseId,
        bytes32 cidDigest,
        uint256 root,
        uint256 nullifier
    ) external {
        Group storage group = groups[groupId];
        if (group.issuer == address(0) || !knownRoot[groupId][root]) revert InvalidGroup();
        if (group.size < group.minSize || nullifier == 0 || cidDigest == bytes32(0)) {
            revert InvalidRecord();
        }
        if (records[cidDigest].exists || hasPosted[msg.sender]) revert InvalidRecord();

        hasPosted[msg.sender] = true;
        records[cidDigest] = Record({
            groupId: groupId,
            caseId: caseId,
            root: root,
            nullifier: nullifier,
            blockNumber: uint64(block.number),
            exists: true
        });
        emit Disclosed(cidDigest, groupId, caseId, root, nullifier);
    }

    function setVerifier(address verifier_) external {
        if (msg.sender != owner) revert NotIssuer();
        if (verifierLocked) revert VerifierLocked();
        if (verifier_ == address(0)) revert InvalidVerifier();
        verifier = IDisclosureVerifier(verifier_);
        emit VerifierChanged(verifier_);
    }

    function lockVerifier() external {
        if (msg.sender != owner) revert NotIssuer();
        if (address(verifier) == address(0)) revert InvalidVerifier();
        verifierLocked = true;
        emit VerifierLockedEvent();
    }

    receive() external payable {}

    function donate() external payable {}
}

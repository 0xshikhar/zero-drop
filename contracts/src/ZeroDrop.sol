// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IDisclosureVerifier} from "./IDisclosureVerifier.sol";

/// @title ZeroDrop
/// @notice Anonymous, verifiable disclosures. Members of a group prove, with a Semaphore v4
///         zero-knowledge proof, that they belong to a group an issuer published, and record
///         a document digest (CID) under a case. One nullifier per member per case.
/// @dev Membership roots are NOT computed on chain. `addMembers` takes the new root the issuer
///      computed off chain (the Semaphore LeanIMT root over all commitments so far). Readers
///      rebuild the tree from the `MembersAdded` events and check the root against the event.
///      The contract only checks that a root was published by the group issuer and that
///      a proof verifies against a published root with at least `minSize` members.
///      The contract does not implement the EIP-8141 VERIFY fallback. Frame-shape checks
///      live in `frame/DisclosureFrameChecks.sol`.
contract ZeroDrop {
    /// @dev BN254 scalar field modulus. Commitments, roots, messages and scopes are reduced to it.
    uint256 public constant SNARK_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    error NotOwner();
    error InvalidGroup();
    error InvalidCommitment();
    error NoCommitments();
    error InvalidRoot();
    error UnknownRoot();
    error InsufficientGroupSize();
    error InvalidCid();
    error AlreadyRecorded();
    error InvalidNullifier();
    error NullifierAlreadyUsed();
    error VerifierNotSet();
    error VerifierIsLocked();
    error InvalidVerifier();
    error InvalidProof();

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
    /// @notice True for every root the issuer has published, including the empty root 0.
    mapping(uint256 groupId => mapping(uint256 root => bool)) public knownRoot;
    /// @notice Number of members that the published root covers.
    mapping(uint256 groupId => mapping(uint256 root => uint32)) public rootSize;
    /// @notice Keyed by `scopeOf(caseId)`, so a nullifier is single-use per case.
    mapping(uint256 scope => mapping(uint256 nullifier => bool)) public nullifierUsed;
    mapping(bytes32 cidDigest => Record) public records;

    IDisclosureVerifier public verifier;
    bool public verifierLocked;
    address public immutable owner;

    event GroupCreated(uint256 indexed groupId, address indexed issuer, uint32 minSize);
    event MembersAdded(uint256 indexed groupId, uint32 startIndex, uint256 root, uint256[] commitments);
    event Disclosed(
        bytes32 indexed cidDigest,
        uint256 indexed groupId,
        bytes32 indexed caseId,
        uint256 root,
        uint256 nullifier,
        uint256 depth,
        bytes proof
    );
    event VerifierChanged(address indexed verifier);
    event VerifierLocked();

    constructor() {
        owner = msg.sender;
    }

    /// @notice Create a group. The caller becomes its issuer.
    /// @param minSize Smallest published root (member count) a disclosure may use.
    function createGroup(uint32 minSize) external returns (uint256 groupId) {
        if (minSize == 0) revert InvalidGroup();
        groupId = nextGroupId++;
        groups[groupId] = Group({issuer: msg.sender, size: 0, minSize: minSize, root: 0});
        knownRoot[groupId][0] = true;
        rootSize[groupId][0] = 0;
        emit GroupCreated(groupId, msg.sender, minSize);
    }

    /// @notice Issuer appends commitments and publishes the Semaphore root over the enlarged group.
    /// @dev The root is computed off chain. The contract does not verify it. Readers rebuild the
    ///      tree from `MembersAdded` events and compare. Roots are not reusable: a root already
    ///      published for this group cannot be published again.
    /// @param commitments Semaphore identity commitments, each nonzero and below the scalar field.
    /// @param newRoot Merkle root over all members after this batch. Must be nonzero.
    function addMembers(uint256 groupId, uint256[] calldata commitments, uint256 newRoot) external {
        Group storage group = groups[groupId];
        if (group.issuer == address(0)) revert InvalidGroup();
        if (msg.sender != group.issuer) revert NotOwner();
        if (commitments.length == 0) revert NoCommitments();
        if (newRoot == 0 || knownRoot[groupId][newRoot]) revert InvalidRoot();

        uint256 newSize = uint256(group.size) + commitments.length;
        if (newSize > type(uint32).max) revert InvalidCommitment();

        for (uint256 i; i < commitments.length; ++i) {
            uint256 commitment = commitments[i];
            if (commitment == 0 || commitment >= SNARK_SCALAR_FIELD) revert InvalidCommitment();
        }

        uint32 startIndex = group.size;
        group.size = uint32(newSize);
        group.root = newRoot;
        knownRoot[groupId][newRoot] = true;
        rootSize[groupId][newRoot] = group.size;
        emit MembersAdded(groupId, startIndex, newRoot, commitments);
    }

    /// @notice Message the proof commits to: binds the document digest, group and case.
    function messageOf(bytes32 cidDigest, uint256 groupId, bytes32 caseId) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(cidDigest, groupId, caseId))) % SNARK_SCALAR_FIELD;
    }

    /// @notice Semaphore scope for a case. Nullifiers are unique per (scope, member).
    function scopeOf(bytes32 caseId) public pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked("zerodrop/v1", caseId))) % SNARK_SCALAR_FIELD;
    }

    /// @notice Record a document digest with a Semaphore membership proof.
    /// @param depth Semaphore Merkle tree depth the proof was generated with.
    /// @param proof ABI-encoded `uint256[8]` Groth16 points, as read by the verifier adapter.
    function record(
        uint256 groupId,
        bytes32 caseId,
        bytes32 cidDigest,
        uint256 root,
        uint256 nullifier,
        uint256 depth,
        bytes calldata proof
    ) external {
        if (groups[groupId].issuer == address(0)) revert InvalidGroup();
        if (!knownRoot[groupId][root]) revert UnknownRoot();
        if (rootSize[groupId][root] < groups[groupId].minSize) revert InsufficientGroupSize();
        if (cidDigest == bytes32(0)) revert InvalidCid();
        if (records[cidDigest].exists) revert AlreadyRecorded();
        if (nullifier == 0) revert InvalidNullifier();

        uint256 scope = scopeOf(caseId);
        if (nullifierUsed[scope][nullifier]) revert NullifierAlreadyUsed();

        IDisclosureVerifier v = verifier;
        if (address(v) == address(0)) revert VerifierNotSet();
        if (!v.verify(root, nullifier, messageOf(cidDigest, groupId, caseId), scope, depth, proof)) {
            revert InvalidProof();
        }

        nullifierUsed[scope][nullifier] = true;
        records[cidDigest] = Record({
            groupId: groupId,
            caseId: caseId,
            root: root,
            nullifier: nullifier,
            blockNumber: uint64(block.number),
            exists: true
        });
        emit Disclosed(cidDigest, groupId, caseId, root, nullifier, depth, proof);
    }

    /// @notice Set the proof verifier. Owner only, and only until the verifier is locked.
    function setVerifier(address verifier_) external {
        if (msg.sender != owner) revert NotOwner();
        if (verifierLocked) revert VerifierIsLocked();
        if (verifier_ == address(0)) revert InvalidVerifier();
        verifier = IDisclosureVerifier(verifier_);
        emit VerifierChanged(verifier_);
    }

    /// @notice Freeze the verifier for good. Owner only, and requires a verifier to be set.
    function lockVerifier() external {
        if (msg.sender != owner) revert NotOwner();
        if (address(verifier) == address(0)) revert VerifierNotSet();
        verifierLocked = true;
        emit VerifierLocked();
    }

    receive() external payable {}

    function donate() external payable {}
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IDisclosureVerifier} from "./IDisclosureVerifier.sol";
import {IStakingRegistry} from "./IStakingRegistry.sol";
import {DisclosureFrameChecks} from "./frame/DisclosureFrameChecks.sol";
import {HegotaSupport, Devnet, Scope, TxParam, FrameParam, FrameMode} from "./vendor/hegota/HegotaSupport.sol";

/// @title ZeroDrop
/// @notice Anonymous, verifiable disclosures. Members of a group prove, with a Semaphore v4
///         zero-knowledge proof, that they belong to a group an issuer published, and record
///         a document digest (CID) under a case. One nullifier per member per case.
/// @dev Membership roots are NOT computed on chain. `addMembers` takes the new root the issuer
///      computed off chain (the Semaphore LeanIMT root over all commitments so far). Readers
///      rebuild the tree from the `MembersAdded` events and check the root against the event.
///      The contract only checks that a root was published by the group issuer and that
///      a proof verifies against a published root with at least `minSize` members.
///
///      Two ways to record:
///      - Frame path (EIP-8141, self relay). ZeroDrop is `tx.sender` and payer. The VERIFY frame lands in
///        `fallback()` (msg.sender == 0xaa), which checks the transaction shape, reads the `record` arguments out of
///        frame 1 and verifies the proof, then `approve(EXECUTION_AND_PAYMENT)`. The SENDER frame then calls
///        `record` with msg.sender == address(this); `record` does not verify the proof a second time on this path
///        (see its NatSpec for the invariant that makes that safe).
///      - Direct path (dev only). Anyone calls `record` in an ordinary transaction. Controlled by the immutable
///        `directRecordEnabled`; the anonymous deployment sets it to false.
///
///      NOT EXERCISED ON A REAL FRAME-CAPABLE NODE. Forge cannot run the frame opcodes (TXPARAM, FRAMEDATALOAD,
///      FRAMEDATACOPY, FRAMEPARAM, APPROVE), so the tests drive `fallback()` against mock helpers that are etched
///      over the real helper addresses. They prove the wiring and the order of the checks. They do not prove:
///        1. that the opcode helpers behave on the devnet as the hegota-support package documents (only APPROVE and
///           SIGPARAM are verified there for the ERC8421_WORKSHOP devnet; TXPARAM, FRAMEDATALOAD, FRAMEDATACOPY and
///           FRAMEPARAM are "from the EIP text");
///        2. the numeric ids/semantics this file relies on: TxParam.MAX_COST (0x06, undocumented in the EIP, ethrex
///           answers it with the transaction's maximum cost), TxParam.NONCE_KEY_0 (0x10), FrameParam.RESOLVED_TARGET
///           for a frame whose target is null, FrameParam.MODE value for SENDER, and FRAMEDATALOAD/FRAMEDATACOPY
///           offsets being relative to the frame's data (the calldata of the SENDER frame, selector at offset 0);
///        3. that the devnet mempool admits the VERIFY frame: the external STATICCALL to the verifier, the SLOADs of
///           `groups`, `knownRoot`, `rootSize`, `records` and `nullifierUsed`, and the CREATE'd helper contracts
///           being callable from VERIFY under the associated-storage and opcode rules; and the gas the VERIFY
///           frame needs with a real Groth16 proof;
///        4. that `approve` (delegatecall into the APPROVE helper) ends the frame with the right scope;
///        5. that the VERIFY frame is delivered with empty calldata and msg.sender == 0xaa, which is what routes it
///           into the payable `fallback()` here (the contract has no `receive()`, by design).
///      Run scripts/gas-spike.ts on the devnet before relying on any of this.
contract ZeroDrop is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    /// @notice Caller of a VERIFY frame in EIP-8141: the protocol's entry point address, 0x...aa.
    address public constant FRAME_ENTRY_POINT = address(0xaa);

    /// @dev Layout of the SENDER frame's calldata, `record(...)` ABI-encoded: 4 byte selector, then seven head
    ///      words (groupId, caseId, cidDigest, root, nullifier, depth, offset of `proof`), then the tail
    ///      (length word, proof bytes). `proof` is the last argument, so its offset is 7 * 32 = 0xe0 in canonical
    ///      encoding (what viem and Solidity produce).
    uint256 internal constant ARGS_BASE = 4;
    uint256 internal constant PROOF_HEAD_OFFSET = 0xe0;
    /// @dev Upper bound on proof bytes copied out of the frame (Semaphore Groth16 is 256).
    uint256 internal constant MAX_PROOF_BYTES = 1024;
    /// @dev Index of the SENDER body frame.
    uint256 internal constant BODY_FRAME = 1;

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
    error DirectRecordDisabled();
    error NotFrameEntry();
    error NotSelfRelay();
    error FrameModeMismatch(uint256 actual);
    error NonceKeyMismatch(uint256 nonceKey, uint256 nullifier);
    error MalformedRecordData(string reason);
    error StakingRegistryNotSet();
    error InsufficientBalance(uint256 balance, uint256 needed);
    error StakeCallFailed();
    error EtherRejected();

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
    /// @notice When false, `record` can only be reached through the frame path (msg.sender == address(this)).
    bool public immutable directRecordEnabled;
    /// @notice Devnet staking registry that `stake` forwards to. Zero means staking is not configured.
    IStakingRegistry public immutable stakingRegistry;

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
    event Staked(uint256 amount, uint32 unstakeDelaySec);
    event StakeUnlocked();
    event StakeWithdrawn(address indexed to);

    /// @param directRecordEnabled_ True for local development: anyone may call `record` directly. False for the
    ///        anonymous deployment, where only the frame path (self call from the SENDER frame) may record.
    /// @param stakingRegistry_ Address of the devnet `IStakingRegistry`, or zero when not staking.
    constructor(bool directRecordEnabled_, address stakingRegistry_) {
        owner = msg.sender;
        directRecordEnabled = directRecordEnabled_;
        stakingRegistry = IStakingRegistry(stakingRegistry_);
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
    /// @dev Callable by `address(this)` (the SENDER frame of a disclosure transaction), or by anyone while
    ///      `directRecordEnabled`.
    ///
    ///      Direct path (msg.sender != address(this)): every precondition is checked here and the proof is
    ///      verified by the verifier.
    ///
    ///      Frame path (msg.sender == address(this)): the proof is NOT verified again. The state checks
    ///      (`_checkRecord`) still run, they are cheap and keep `record` self-consistent, but the verifier call is
    ///      skipped, because the VERIFY frame of the same transaction already ran `_checkRecord` and
    ///      `_verifyProof` on exactly these arguments (see `_verifyDisclosure`). That is safe only because of
    ///      this invariant:
    ///
    ///        INVARIANT: the only way `msg.sender == address(this)` reaches `record` is the SENDER frame of a
    ///        transaction whose VERIFY frame ran `_verifyDisclosure` to `approve`, and that VERIFY frame read its
    ///        arguments from this very frame's calldata.
    ///
    ///      Why it holds:
    ///        1. ZeroDrop never calls itself with caller-chosen data. Its outbound calls are: the verifier (a `view`
    ///           interface, so STATICCALL: it cannot reach a state-changing `record`), the immutable staking
    ///           registry with the fixed selectors `addStake`/`unlockStake`/`withdrawStake`, and the HegotaSupport
    ///           opcode helpers (fixed code; `approve` is a delegatecall into the APPROVE helper). There is no
    ///           generic forwarding, `multicall` or `execute`. Anyone adding such a function MUST re-read this.
    ///        2. A frame transaction whose `tx.sender` is this contract can run a SENDER frame only after this
    ///           contract approved it, and it approves only at the end of `_verifyDisclosure`.
    ///        3. `_verifyDisclosure` requires exactly two frames, frame 1 a SENDER frame to `address(this)` with
    ///           value 0 and the `record` selector, and decodes the arguments from frame 1's calldata. Frame 1 is the
    ///           only SENDER frame and it is the call that reaches `record`, so the calldata that was verified is
    ///           the calldata that executes. State cannot change between the two frames: a VERIFY frame writes
    ///           nothing, and the SENDER frame follows it in the same transaction.
    ///        4. Every `record` precondition is enforced by the VERIFY frame for the same arguments: the group
    ///           exists, `knownRoot`, `rootSize >= minSize`, `cidDigest != 0`, the digest unused, `nullifier != 0`,
    ///           the nullifier unused for `scopeOf(caseId)` (all in `_checkRecord`, which both paths share), and
    ///           `verifier.verify(root, nullifier, messageOf(cid, group, case), scopeOf(case), depth, proof)`
    ///           (in `_verifyProof`, which both paths share).
    ///
    ///      The frame path therefore pays for one verification (in the VERIFY frame), not two. If the VERIFY frame
    ///      is ever changed to skip any of the checks above, this skip must be removed.
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
        bool selfCall = msg.sender == address(this);
        if (!selfCall && !directRecordEnabled) revert DirectRecordDisabled();

        uint256 scope = _checkRecord(groupId, caseId, cidDigest, root, nullifier);
        if (!selfCall) _verifyProof(groupId, caseId, cidDigest, root, nullifier, depth, scope, proof);

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

    /// @dev State checks shared by `record` and the VERIFY frame. Returns the case scope.
    function _checkRecord(uint256 groupId, bytes32 caseId, bytes32 cidDigest, uint256 root, uint256 nullifier)
        internal
        view
        returns (uint256 scope)
    {
        if (groups[groupId].issuer == address(0)) revert InvalidGroup();
        if (!knownRoot[groupId][root]) revert UnknownRoot();
        if (rootSize[groupId][root] < groups[groupId].minSize) revert InsufficientGroupSize();
        if (cidDigest == bytes32(0)) revert InvalidCid();
        if (records[cidDigest].exists) revert AlreadyRecorded();
        if (nullifier == 0) revert InvalidNullifier();

        scope = scopeOf(caseId);
        if (nullifierUsed[scope][nullifier]) revert NullifierAlreadyUsed();
    }

    function _verifyProof(
        uint256 groupId,
        bytes32 caseId,
        bytes32 cidDigest,
        uint256 root,
        uint256 nullifier,
        uint256 depth,
        uint256 scope,
        bytes memory proof
    ) internal view {
        IDisclosureVerifier v = verifier;
        if (address(v) == address(0)) revert VerifierNotSet();
        if (!v.verify(root, nullifier, messageOf(cidDigest, groupId, caseId), scope, depth, proof)) {
            revert InvalidProof();
        }
    }

    // ---------------------------------------------------------------------------------------------------------
    // EIP-8141 VERIFY frame
    // ---------------------------------------------------------------------------------------------------------

    /// @notice VERIFY frame entry (msg.sender == 0x...aa), which is also how plain ether transfers arrive.
    /// @dev Why no `receive()`: a contract that declares `receive()` sends every empty-calldata call there, and the
    ///      VERIFY frame has empty calldata, so it would never reach the verification code. This single payable
    ///      fallback splits the two by caller. From 0xaa it verifies (and refuses value). From anyone else, empty
    ///      calldata is accepted as a float top-up (like `receive()`) and any other unknown call reverts with
    ///      `NotFrameEntry`, so the contract keeps rejecting unknown selectors as before.
    /// @dev Checks, in order (docs/architecture.md section 4). Any failure reverts and the transaction is invalid.
    ///      1. FRAME_COUNT == 2; frame 1 is a SENDER frame to `address(this)`, value 0, selector `record`.
    ///      2. Frame 1 execution gas limit >= MIN_BODY_GAS.
    ///      3. MAX_COST <= MAX_COST_CAP.
    ///      4. `record` arguments read from frame 1's data: root is known, group has >= minSize members, the
    ///         digest is unused, nullifier != 0 and unused, and the keyed nonce NONCE_KEY_0 equals the nullifier
    ///         (the protocol then enforces one transaction per nullifier).
    ///      5. The verifier accepts the proof for (root, nullifier, messageOf(cid, group, case), scopeOf(case), depth).
    ///      6. approve(EXECUTION_AND_PAYMENT): the contract pays and executes.
    ///      The proof comes from frame 1's calldata (it is the last `record` argument), not from SIGDATACOPY. The
    ///      ARBITRARY signature entry that scripts and frametx.ts also fill with the proof is not read. The message
    ///      is `messageOf(...)`, not SIG_HASH, so the proof is bound to the document, group and case but a mempool
    ///      observer can replay the same proof with different fees. The keyed nonce makes a replay unusable once
    ///      the first transaction lands.
    ///      NOT EXERCISED ON A REAL NODE, see the contract header.
    fallback() external payable {
        if (msg.sender == FRAME_ENTRY_POINT) {
            if (msg.value != 0) revert EtherRejected();
            _verifyDisclosure();
            return;
        }
        // Not the protocol caller: behave like a plain `receive()` (empty calldata tops up the float) and reject
        // everything else, as a contract without a fallback would.
        if (msg.data.length != 0) revert NotFrameEntry();
    }

    function _verifyDisclosure() internal {
        uint256 frameCount = txparam(TxParam.FRAME_COUNT);
        if (frameCount != DisclosureFrameChecks.FRAME_COUNT) {
            revert DisclosureFrameChecks.FrameCountMismatch(frameCount);
        }
        uint256 mode = frameparam(BODY_FRAME, FrameParam.MODE);
        if (mode != uint256(FrameMode.SENDER)) revert FrameModeMismatch(mode);

        RecordArgs memory a = _readRecordArgs();

        DisclosureFrameChecks.check(
            DisclosureFrameChecks.Shape({
                frameCount: frameCount,
                senderTarget: address(uint160(frameparam(BODY_FRAME, FrameParam.RESOLVED_TARGET))),
                senderValue: frameparam(BODY_FRAME, FrameParam.VALUE),
                selector: bytes4(framedataload(0, BODY_FRAME)),
                senderExecutionGas: frameparam(BODY_FRAME, FrameParam.EXECUTION_GAS_LIMIT),
                maxCost: txparam(TxParam.MAX_COST),
                rootKnown: knownRoot[a.groupId][a.root],
                nullifier: txparam(TxParam.NONCE_KEY_0),
                expectedTarget: address(this)
            })
        );

        uint256 nonceKey = txparam(TxParam.NONCE_KEY_0);
        if (nonceKey != a.nullifier) revert NonceKeyMismatch(nonceKey, a.nullifier);

        uint256 scope = _checkRecord(a.groupId, a.caseId, a.cidDigest, a.root, a.nullifier);
        _verifyProof(a.groupId, a.caseId, a.cidDigest, a.root, a.nullifier, a.depth, scope, a.proof);

        approve(Scope.EXECUTION_AND_PAYMENT);
    }

    struct RecordArgs {
        uint256 groupId;
        bytes32 caseId;
        bytes32 cidDigest;
        uint256 root;
        uint256 nullifier;
        uint256 depth;
        bytes proof;
    }

    /// @dev Decodes frame 1's calldata with FRAMEDATALOAD/FRAMEDATACOPY. Requires the canonical ABI layout
    ///      (proof offset 0xe0, proof last, data long enough), which is what `encodeFunctionData` produces.
    function _readRecordArgs() internal view returns (RecordArgs memory a) {
        a.groupId = uint256(framedataload(ARGS_BASE, BODY_FRAME));
        a.caseId = framedataload(ARGS_BASE + 32, BODY_FRAME);
        a.cidDigest = framedataload(ARGS_BASE + 64, BODY_FRAME);
        a.root = uint256(framedataload(ARGS_BASE + 96, BODY_FRAME));
        a.nullifier = uint256(framedataload(ARGS_BASE + 128, BODY_FRAME));
        a.depth = uint256(framedataload(ARGS_BASE + 160, BODY_FRAME));

        if (uint256(framedataload(ARGS_BASE + 192, BODY_FRAME)) != PROOF_HEAD_OFFSET) {
            revert MalformedRecordData("proof offset");
        }
        uint256 proofLength = uint256(framedataload(ARGS_BASE + PROOF_HEAD_OFFSET, BODY_FRAME));
        if (proofLength == 0 || proofLength > MAX_PROOF_BYTES) revert MalformedRecordData("proof length");
        uint256 proofStart = ARGS_BASE + PROOF_HEAD_OFFSET + 32;
        if (frameparam(BODY_FRAME, FrameParam.DATA_LENGTH) < proofStart + proofLength) {
            revert MalformedRecordData("data too short");
        }
        a.proof = framedatacopy(proofStart, proofLength, BODY_FRAME);
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

    // ---------------------------------------------------------------------------------------------------------
    // Staking (devnet registry). The registry keys stake by msg.sender, so the contract has to call it itself.
    // ---------------------------------------------------------------------------------------------------------

    /// @notice Stake `amount` of the contract's own balance (float plus anything sent with this call) at the devnet
    ///         staking registry, so the VERIFY frame may use the staked-entity budget (>100k gas).
    /// @dev Owner only, normal transaction. Interface: `IStakingRegistry.addStake(uint32)` from
    ///      docs.altmempool.wtf (see IStakingRegistry.sol). The devnet wants stake strictly above 0.01 ETH and
    ///      `unstakeDelaySec >= 86400`. Not tested against the real registry, only against a mock.
    function stake(uint32 unstakeDelaySec, uint256 amount) external payable {
        _onlyOwner();
        IStakingRegistry registry = _registry();
        if (address(this).balance < amount) revert InsufficientBalance(address(this).balance, amount);
        registry.addStake{value: amount}(unstakeDelaySec);
        emit Staked(amount, unstakeDelaySec);
    }

    /// @notice Start the stake withdrawal delay. The contract stops counting as staked immediately.
    function unlockStake() external {
        _onlyOwner();
        _registry().unlockStake();
        emit StakeUnlocked();
    }

    /// @notice Withdraw the stake to `to` once the registry's delay has passed. Owner only.
    function withdrawStake(address payable to) external {
        _onlyOwner();
        _registry().withdrawStake(to);
        emit StakeWithdrawn(to);
    }

    function _onlyOwner() private view {
        if (msg.sender != owner) revert NotOwner();
    }

    function _registry() private view returns (IStakingRegistry registry) {
        registry = stakingRegistry;
        if (address(registry) == address(0)) revert StakingRegistryNotSet();
    }

    // ---------------------------------------------------------------------------------------------------------
    // Float
    // ---------------------------------------------------------------------------------------------------------

    /// @notice Top up the gas float the contract pays disclosures from. Plain transfers (empty calldata) work
    ///         too, through `fallback()`. The protocol caller 0xaa is refused so a VERIFY frame can not be
    ///         steered into the ether path.
    function donate() external payable {
        if (msg.sender == FRAME_ENTRY_POINT) revert EtherRejected();
    }
}

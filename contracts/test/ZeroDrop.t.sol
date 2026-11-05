// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ZeroDrop} from "../src/ZeroDrop.sol";
import {IDisclosureVerifier} from "../src/IDisclosureVerifier.sol";
import {MockVerifier} from "../src/verifiers/MockVerifier.sol";

/// @dev Accepts only one exact argument tuple. Proves `record` passes the right values.
contract ExpectingVerifier is IDisclosureVerifier {
    uint256 internal immutable root_;
    uint256 internal immutable nullifier_;
    uint256 internal immutable message_;
    uint256 internal immutable scope_;
    uint256 internal immutable depth_;

    constructor(uint256 root, uint256 nullifier, uint256 message, uint256 scope, uint256 depth) {
        root_ = root;
        nullifier_ = nullifier;
        message_ = message;
        scope_ = scope;
        depth_ = depth;
    }

    function verify(uint256 root, uint256 nullifier, uint256 messageHash, uint256 scopeHash, uint256 depth, bytes calldata)
        external
        view
        returns (bool)
    {
        return root == root_ && nullifier == nullifier_ && messageHash == message_ && scopeHash == scope_
            && depth == depth_;
    }
}

/// @dev Always rejects.
contract RejectingVerifier is IDisclosureVerifier {
    function verify(uint256, uint256, uint256, uint256, uint256, bytes calldata) external pure returns (bool) {
        return false;
    }
}

contract ZeroDropTest is Test {
    ZeroDrop internal zd;
    MockVerifier internal mock;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    bytes32 internal constant CASE_A = keccak256("case-a");
    bytes32 internal constant CASE_B = keccak256("case-b");
    bytes32 internal constant CID_1 = keccak256("cid-1");
    bytes32 internal constant CID_2 = keccak256("cid-2");
    bytes internal constant PROOF = hex"c0ffee";

    uint256 internal constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    function setUp() public {
        zd = new ZeroDrop();
        mock = new MockVerifier(0);
    }

    // ---------- helpers ----------

    function _members(uint256 seed, uint256 n) internal pure returns (uint256[] memory c) {
        c = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            c[i] = seed + i + 1;
        }
    }

    function _groupWithMembers(uint32 minSize, uint256 n, uint256 root) internal returns (uint256 g) {
        g = zd.createGroup(minSize);
        zd.addMembers(g, _members(root, n), root);
    }

    function _exists(bytes32 cid) internal view returns (bool exists) {
        (,,,,, exists) = zd.records(cid);
    }

    function _record(uint256 g, bytes32 caseId, bytes32 cid, uint256 root, uint256 nullifier) internal {
        zd.record(g, caseId, cid, root, nullifier, 2, PROOF);
    }

    // ---------- createGroup ----------

    function test_createGroup_setsIssuerAndEmptyRoot() public {
        vm.prank(alice);
        uint256 g = zd.createGroup(3);

        assertEq(g, 1);
        assertEq(zd.nextGroupId(), 2);
        (address issuer, uint32 size, uint32 minSize, uint256 root) = zd.groups(g);
        assertEq(issuer, alice);
        assertEq(size, 0);
        assertEq(minSize, 3);
        assertEq(root, 0);
        assertTrue(zd.knownRoot(g, 0));
        assertEq(zd.rootSize(g, 0), 0);
    }

    function test_createGroup_emitsEvent() public {
        vm.expectEmit(true, true, false, true);
        emit ZeroDrop.GroupCreated(1, alice, 5);
        vm.prank(alice);
        zd.createGroup(5);
    }

    function test_createGroup_rejectsZeroMinSize() public {
        vm.expectRevert(ZeroDrop.InvalidGroup.selector);
        zd.createGroup(0);
    }

    function test_createGroup_idsIncrease() public {
        assertEq(zd.createGroup(1), 1);
        assertEq(zd.createGroup(1), 2);
    }

    // ---------- addMembers ----------

    function test_addMembers_setsRootAndSize() public {
        uint256 g = zd.createGroup(1);
        uint256[] memory c = _members(100, 3);

        vm.expectEmit(true, false, false, true);
        emit ZeroDrop.MembersAdded(g, 0, 0xabc, c);
        zd.addMembers(g, c, 0xabc);

        (, uint32 size,, uint256 root) = zd.groups(g);
        assertEq(size, 3);
        assertEq(root, 0xabc);
        assertTrue(zd.knownRoot(g, 0xabc));
        assertEq(zd.rootSize(g, 0xabc), 3);
    }

    function test_addMembers_secondBatchAppends() public {
        uint256 g = zd.createGroup(1);
        zd.addMembers(g, _members(1, 2), 0x111);

        uint256[] memory more = _members(50, 2);
        vm.expectEmit(true, false, false, true);
        emit ZeroDrop.MembersAdded(g, 2, 0x222, more);
        zd.addMembers(g, more, 0x222);

        (, uint32 size,, uint256 root) = zd.groups(g);
        assertEq(size, 4);
        assertEq(root, 0x222);
        assertEq(zd.rootSize(g, 0x222), 4);
        // Older roots stay valid for proofs made before the batch.
        assertTrue(zd.knownRoot(g, 0x111));
        assertEq(zd.rootSize(g, 0x111), 2);
    }

    function test_addMembers_onlyIssuer() public {
        uint256 g = zd.createGroup(1);
        vm.prank(bob);
        vm.expectRevert(ZeroDrop.NotOwner.selector);
        zd.addMembers(g, _members(1, 1), 0x1);
    }

    function test_addMembers_unknownGroup() public {
        vm.expectRevert(ZeroDrop.InvalidGroup.selector);
        zd.addMembers(42, _members(1, 1), 0x1);
    }

    function test_addMembers_rejectsZeroCommitment() public {
        uint256 g = zd.createGroup(1);
        uint256[] memory c = new uint256[](2);
        c[0] = 5;
        c[1] = 0;
        vm.expectRevert(ZeroDrop.InvalidCommitment.selector);
        zd.addMembers(g, c, 0x1);
    }

    function test_addMembers_rejectsCommitmentAboveField() public {
        uint256 g = zd.createGroup(1);
        uint256[] memory c = new uint256[](1);
        c[0] = FIELD;
        vm.expectRevert(ZeroDrop.InvalidCommitment.selector);
        zd.addMembers(g, c, 0x1);
    }

    function test_addMembers_acceptsLargestFieldElement() public {
        uint256 g = zd.createGroup(1);
        uint256[] memory c = new uint256[](1);
        c[0] = FIELD - 1;
        zd.addMembers(g, c, 0x1);
        assertEq(zd.rootSize(g, 0x1), 1);
    }

    function test_addMembers_rejectsEmptyBatch() public {
        uint256 g = zd.createGroup(1);
        vm.expectRevert(ZeroDrop.NoCommitments.selector);
        zd.addMembers(g, new uint256[](0), 0x1);
    }

    function test_addMembers_rejectsZeroRoot() public {
        uint256 g = zd.createGroup(1);
        vm.expectRevert(ZeroDrop.InvalidRoot.selector);
        zd.addMembers(g, _members(1, 1), 0);
    }

    function test_addMembers_rejectsReusedRoot() public {
        uint256 g = zd.createGroup(1);
        zd.addMembers(g, _members(1, 1), 0x77);
        vm.expectRevert(ZeroDrop.InvalidRoot.selector);
        zd.addMembers(g, _members(9, 1), 0x77);
    }

    function test_addMembers_rejectsEmptyRootReuse() public {
        uint256 g = zd.createGroup(1);
        // Root 0 is the empty-tree root and is already known. It must not be published again.
        vm.expectRevert(ZeroDrop.InvalidRoot.selector);
        zd.addMembers(g, _members(1, 1), 0);
    }

    // ---------- messageOf / scopeOf ----------

    function test_messageOf_matchesFormula() public view {
        uint256 m = zd.messageOf(CID_1, 7, CASE_A);
        assertEq(m, uint256(keccak256(abi.encode(CID_1, uint256(7), CASE_A))) % FIELD);
        assertLt(m, FIELD);
        assertTrue(m != zd.messageOf(CID_2, 7, CASE_A));
        assertTrue(m != zd.messageOf(CID_1, 8, CASE_A));
        assertTrue(m != zd.messageOf(CID_1, 7, CASE_B));
    }

    function test_scopeOf_matchesFormula() public view {
        uint256 s = zd.scopeOf(CASE_A);
        assertEq(s, uint256(keccak256(abi.encodePacked("zerodrop/v1", CASE_A))) % FIELD);
        assertLt(s, FIELD);
        assertTrue(s != zd.scopeOf(CASE_B));
    }

    // ---------- record ----------

    function test_record_withMockVerifier_storesAndEmits() public {
        zd.setVerifier(address(mock));
        uint256 g = _groupWithMembers(1, 3, 0x10);

        vm.roll(12345);
        vm.expectEmit(true, true, true, true);
        emit ZeroDrop.Disclosed(CID_1, g, CASE_A, 0x10, 0xdead, 2, PROOF);
        _record(g, CASE_A, CID_1, 0x10, 0xdead);

        (uint256 gid, bytes32 caseId, uint256 root, uint256 nullifier, uint64 blockNumber, bool exists) =
            zd.records(CID_1);
        assertEq(gid, g);
        assertEq(caseId, CASE_A);
        assertEq(root, 0x10);
        assertEq(nullifier, 0xdead);
        assertEq(blockNumber, 12345);
        assertTrue(exists);
        assertTrue(zd.nullifierUsed(zd.scopeOf(CASE_A), 0xdead));
    }

    function test_record_passesMessageAndScopeToVerifier() public {
        uint256 g = _groupWithMembers(1, 1, 0x20);
        ExpectingVerifier ev = new ExpectingVerifier(
            0x20, 0xbeef, zd.messageOf(CID_1, g, CASE_A), zd.scopeOf(CASE_A), 3
        );
        zd.setVerifier(address(ev));
        zd.record(g, CASE_A, CID_1, 0x20, 0xbeef, 3, PROOF);
        assertTrue(_exists(CID_1));
    }

    function test_record_rejectsWhenVerifierNotSet() public {
        uint256 g = _groupWithMembers(1, 1, 0x30);
        vm.expectRevert(ZeroDrop.VerifierNotSet.selector);
        _record(g, CASE_A, CID_1, 0x30, 1);
    }

    function test_record_invalidProofReverts() public {
        zd.setVerifier(address(new RejectingVerifier()));
        uint256 g = _groupWithMembers(1, 1, 0x31);
        vm.expectRevert(ZeroDrop.InvalidProof.selector);
        _record(g, CASE_A, CID_1, 0x31, 1);
        assertFalse(_exists(CID_1));
        assertFalse(zd.nullifierUsed(zd.scopeOf(CASE_A), 1));
    }

    function test_record_unknownGroupReverts() public {
        zd.setVerifier(address(mock));
        vm.expectRevert(ZeroDrop.InvalidGroup.selector);
        _record(99, CASE_A, CID_1, 0x1, 1);
    }

    function test_record_unknownRootReverts() public {
        zd.setVerifier(address(mock));
        uint256 g = _groupWithMembers(1, 2, 0x40);
        vm.expectRevert(ZeroDrop.UnknownRoot.selector);
        _record(g, CASE_A, CID_1, 0x41, 1);
    }

    function test_record_emptyRootIsKnownButBelowMinSize() public {
        zd.setVerifier(address(mock));
        uint256 g = zd.createGroup(1);
        vm.expectRevert(ZeroDrop.InsufficientGroupSize.selector);
        _record(g, CASE_A, CID_1, 0, 1);
    }

    function test_record_minSizeGate() public {
        zd.setVerifier(address(mock));
        uint256 g = zd.createGroup(3);

        // Two members: below the gate.
        zd.addMembers(g, _members(1, 2), 0x50);
        vm.expectRevert(ZeroDrop.InsufficientGroupSize.selector);
        _record(g, CASE_A, CID_1, 0x50, 1);

        // Grow to three members: the new root passes the gate.
        zd.addMembers(g, _members(20, 1), 0x51);
        _record(g, CASE_A, CID_1, 0x51, 1);
        assertTrue(_exists(CID_1));

        // The old root still has size 2 and stays blocked.
        vm.expectRevert(ZeroDrop.InsufficientGroupSize.selector);
        _record(g, CASE_A, CID_2, 0x50, 2);
    }

    function test_record_rejectsZeroCid() public {
        zd.setVerifier(address(mock));
        uint256 g = _groupWithMembers(1, 1, 0x60);
        vm.expectRevert(ZeroDrop.InvalidCid.selector);
        _record(g, CASE_A, bytes32(0), 0x60, 1);
    }

    function test_record_duplicateCidReverts() public {
        zd.setVerifier(address(mock));
        uint256 g = _groupWithMembers(1, 1, 0x70);
        _record(g, CASE_A, CID_1, 0x70, 1);

        vm.expectRevert(ZeroDrop.AlreadyRecorded.selector);
        _record(g, CASE_B, CID_1, 0x70, 2);
    }

    function test_record_zeroNullifierReverts() public {
        zd.setVerifier(address(mock));
        uint256 g = _groupWithMembers(1, 1, 0x80);
        vm.expectRevert(ZeroDrop.InvalidNullifier.selector);
        _record(g, CASE_A, CID_1, 0x80, 0);
    }

    function test_record_replayedNullifierSameCaseRejected() public {
        zd.setVerifier(address(mock));
        uint256 g = _groupWithMembers(1, 1, 0x90);
        _record(g, CASE_A, CID_1, 0x90, 555);

        vm.expectRevert(ZeroDrop.NullifierAlreadyUsed.selector);
        _record(g, CASE_A, CID_2, 0x90, 555);
    }

    function test_record_sameNullifierDifferentCaseAccepted() public {
        zd.setVerifier(address(mock));
        uint256 g = _groupWithMembers(1, 1, 0xA0);
        _record(g, CASE_A, CID_1, 0xA0, 555);
        _record(g, CASE_B, CID_2, 0xA0, 555);

        assertTrue(_exists(CID_1));
        assertTrue(_exists(CID_2));
        assertTrue(zd.nullifierUsed(zd.scopeOf(CASE_A), 555));
        assertTrue(zd.nullifierUsed(zd.scopeOf(CASE_B), 555));
    }

    // ---------- verifier admin ----------

    function test_setVerifier_onlyOwner() public {
        vm.prank(bob);
        vm.expectRevert(ZeroDrop.NotOwner.selector);
        zd.setVerifier(address(mock));
    }

    function test_setVerifier_rejectsZeroAddress() public {
        vm.expectRevert(ZeroDrop.InvalidVerifier.selector);
        zd.setVerifier(address(0));
    }

    function test_setVerifier_emitsAndStores() public {
        vm.expectEmit(true, false, false, false);
        emit ZeroDrop.VerifierChanged(address(mock));
        zd.setVerifier(address(mock));
        assertEq(address(zd.verifier()), address(mock));
    }

    function test_lockVerifier_requiresVerifier() public {
        vm.expectRevert(ZeroDrop.VerifierNotSet.selector);
        zd.lockVerifier();
    }

    function test_lockVerifier_onlyOwner() public {
        zd.setVerifier(address(mock));
        vm.prank(bob);
        vm.expectRevert(ZeroDrop.NotOwner.selector);
        zd.lockVerifier();
    }

    function test_lockVerifier_blocksSetVerifier() public {
        zd.setVerifier(address(mock));
        vm.expectEmit(false, false, false, false);
        emit ZeroDrop.VerifierLocked();
        zd.lockVerifier();
        assertTrue(zd.verifierLocked());

        RejectingVerifier rejecting = new RejectingVerifier();
        vm.expectRevert(ZeroDrop.VerifierIsLocked.selector);
        zd.setVerifier(address(rejecting));
        assertEq(address(zd.verifier()), address(mock));
    }

    function test_donate_and_receive_acceptEth() public {
        vm.deal(alice, 2 ether);
        vm.prank(alice);
        zd.donate{value: 1 ether}();
        vm.prank(alice);
        (bool ok,) = address(zd).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(address(zd).balance, 2 ether);
    }
}

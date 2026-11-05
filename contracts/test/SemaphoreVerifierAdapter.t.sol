// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {ZeroDrop} from "../src/ZeroDrop.sol";
import {SemaphoreVerifierAdapter} from "../src/verifiers/SemaphoreVerifierAdapter.sol";
import {SemaphoreVerifier} from "../src/vendor/semaphore/base/SemaphoreVerifier.sol";
import {DisclosureFrameChecks} from "../src/frame/DisclosureFrameChecks.sol";

/// @notice End-to-end checks against the real Semaphore v4 Groth16 verifier, using a proof generated
///         by scripts/make-fixture.ts (contracts/test/fixtures/semaphore-proof.json).
contract SemaphoreVerifierAdapterTest is Test {
    string internal constant FIXTURE = "test/fixtures/semaphore-proof.json";

    SemaphoreVerifier internal semaphore;
    SemaphoreVerifierAdapter internal adapter;
    ZeroDrop internal zd;

    // Fixture values.
    uint256 internal groupId;
    bytes32 internal caseId;
    bytes32 internal cidDigest;
    uint256[] internal commitments;
    uint256 internal root;
    uint256 internal nullifier;
    uint256 internal message;
    uint256 internal scope;
    uint256 internal depth;
    bytes internal proof;

    function setUp() public {
        string memory json = vm.readFile(FIXTURE);
        groupId = vm.parseJsonUint(json, ".groupId");
        caseId = bytes32(vm.parseJsonBytes32(json, ".caseId"));
        cidDigest = bytes32(vm.parseJsonBytes32(json, ".cidDigest"));
        commitments = vm.parseJsonUintArray(json, ".commitments");
        root = vm.parseJsonUint(json, ".root");
        nullifier = vm.parseJsonUint(json, ".nullifier");
        message = vm.parseJsonUint(json, ".message");
        scope = vm.parseJsonUint(json, ".scope");
        depth = vm.parseJsonUint(json, ".depth");
        proof = vm.parseJsonBytes(json, ".proof");

        semaphore = new SemaphoreVerifier();
        adapter = new SemaphoreVerifierAdapter(address(semaphore));
        zd = new ZeroDrop(true, address(0));
    }

    /// @dev Creates the fixture group on a fresh ZeroDrop and publishes the fixture root.
    function _fixtureGroup() internal {
        uint256 g = zd.createGroup(uint32(commitments.length));
        assertEq(g, groupId, "fixture is bound to group id 1");
        zd.addMembers(g, commitments, root);
    }

    function test_fixtureMessageAndScopeMatchSolidity() public view {
        assertEq(zd.messageOf(cidDigest, groupId, caseId), message);
        assertEq(zd.scopeOf(caseId), scope);
    }

    function test_adapterAcceptsFixtureProof() public view {
        assertTrue(adapter.verify(root, nullifier, message, scope, depth, proof));
    }

    function test_adapterRejectsWrongNullifier() public view {
        assertFalse(adapter.verify(root, nullifier + 1, message, scope, depth, proof));
    }

    function test_adapterRejectsWrongRoot() public view {
        assertFalse(adapter.verify(root + 1, nullifier, message, scope, depth, proof));
    }

    function test_adapterRejectsWrongDepth() public view {
        // Same proof, different verification key: must not verify.
        assertFalse(adapter.verify(root, nullifier, message, scope, depth + 1, proof));
    }

    function test_adapterRejectsTamperedPoint() public view {
        uint256[8] memory p = abi.decode(proof, (uint256[8]));
        p[6] = p[6] ^ 1;
        assertFalse(adapter.verify(root, nullifier, message, scope, depth, abi.encode(p)));
    }

    function test_adapterRevertsOnUnsupportedDepth() public {
        vm.expectRevert(abi.encodeWithSelector(SemaphoreVerifierAdapter.UnsupportedDepth.selector, 0));
        adapter.verify(root, nullifier, message, scope, 0, proof);

        vm.expectRevert(abi.encodeWithSelector(SemaphoreVerifierAdapter.UnsupportedDepth.selector, 33));
        adapter.verify(root, nullifier, message, scope, 33, proof);
    }

    function test_adapterRevertsOnBadProofLength() public {
        vm.expectRevert(abi.encodeWithSelector(SemaphoreVerifierAdapter.BadProofLength.selector, 255));
        adapter.verify(root, nullifier, message, scope, depth, new bytes(255));
    }

    function test_adapterRejectsZeroAddressVerifier() public {
        vm.expectRevert(SemaphoreVerifierAdapter.ZeroAddress.selector);
        new SemaphoreVerifierAdapter(address(0));
    }

    function test_recordWithRealProof_succeeds() public {
        zd.setVerifier(address(adapter));
        zd.lockVerifier();
        _fixtureGroup();

        uint256 gasBefore = gasleft();
        zd.record(groupId, caseId, cidDigest, root, nullifier, depth, proof);
        uint256 used = gasBefore - gasleft();
        console2.log("record() gas with real Groth16 proof (depth 2):", used);
        assertLe(used, DisclosureFrameChecks.MIN_BODY_GAS, "body-frame floor must cover record()");

        (,,,,, bool exists) = zd.records(cidDigest);
        assertTrue(exists);
        assertTrue(zd.nullifierUsed(scope, nullifier));
    }

    function test_recordWithRealProof_rejectsReplayInSameCase() public {
        zd.setVerifier(address(adapter));
        _fixtureGroup();
        zd.record(groupId, caseId, cidDigest, root, nullifier, depth, proof);

        vm.expectRevert(ZeroDrop.AlreadyRecorded.selector);
        zd.record(groupId, caseId, cidDigest, root, nullifier, depth, proof);
    }

    function test_recordWithRealProof_boundToCase() public {
        zd.setVerifier(address(adapter));
        _fixtureGroup();

        // The proof commits to the fixture case. Another case gives another scope and message.
        vm.expectRevert(ZeroDrop.InvalidProof.selector);
        zd.record(groupId, keccak256("another-case"), cidDigest, root, nullifier, depth, proof);
    }

    function test_recordWithRealProof_boundToDocument() public {
        zd.setVerifier(address(adapter));
        _fixtureGroup();

        vm.expectRevert(ZeroDrop.InvalidProof.selector);
        zd.record(groupId, caseId, keccak256("other-document"), root, nullifier, depth, proof);
    }

    function test_recordWithRealProof_rejectsWrongDepth() public {
        zd.setVerifier(address(adapter));
        _fixtureGroup();

        vm.expectRevert(ZeroDrop.InvalidProof.selector);
        zd.record(groupId, caseId, cidDigest, root, nullifier, depth + 1, proof);
    }
}

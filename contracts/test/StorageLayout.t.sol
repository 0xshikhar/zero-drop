// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ZeroDrop} from "../src/ZeroDrop.sol";
import {MockVerifier} from "../src/verifiers/MockVerifier.sol";

/// @notice Pins the storage slots that readers use for `eth_getProof` (packages/core/src/storageproof.ts,
///         `ZERODROP_SLOTS`). If a storage variable of ZeroDrop is added, removed or reordered, this fails, and
///         the constants in storageproof.ts must follow. Reads the raw slots with `vm.load` and compares them with
///         the public getters, so it checks the real compiler layout, not a copy of it.
contract StorageLayoutTest is Test {
    // Keep in sync with ZERODROP_SLOTS in packages/core/src/storageproof.ts.
    uint256 internal constant SLOT_KNOWN_ROOT = 2;
    uint256 internal constant SLOT_ROOT_SIZE = 3;
    uint256 internal constant SLOT_RECORDS = 5;

    ZeroDrop internal zd;
    bytes32 internal constant CASE = keccak256("case-a");
    bytes32 internal constant CID = keccak256("cid-1");
    uint256 internal constant ROOT = 777;
    uint256 internal constant NULLIFIER = 4242;
    uint256 internal g;

    function setUp() public {
        zd = new ZeroDrop(true, address(0));
        zd.setVerifier(address(new MockVerifier(0)));
        g = zd.createGroup(2);
        uint256[] memory c = new uint256[](3);
        c[0] = 1;
        c[1] = 2;
        c[2] = 3;
        zd.addMembers(g, c, ROOT);
        vm.roll(1234);
        zd.record(g, CASE, CID, ROOT, NULLIFIER, 2, new bytes(256));
    }

    function _load(uint256 slot) internal view returns (bytes32) {
        return vm.load(address(zd), bytes32(slot));
    }

    function test_recordsSlots() public view {
        uint256 base = uint256(keccak256(abi.encode(CID, SLOT_RECORDS)));
        (uint256 gid, bytes32 caseId, uint256 root, uint256 nullifier, uint64 blockNumber, bool exists) = zd.records(CID);
        assertEq(uint256(_load(base)), gid, "groupId at +0");
        assertEq(_load(base + 1), caseId, "caseId at +1");
        assertEq(uint256(_load(base + 2)), root, "root at +2");
        assertEq(uint256(_load(base + 3)), nullifier, "nullifier at +3");
        // blockNumber (uint64) in the low 8 bytes and exists (bool) in the next byte of the same slot.
        uint256 packed = uint256(_load(base + 4));
        assertEq(packed & type(uint64).max, blockNumber, "blockNumber low 8 bytes of +4");
        assertEq(blockNumber, 1234);
        assertEq((packed >> 64) & 0xff, exists ? 1 : 0, "exists at byte 8 of +4");
        assertEq(packed >> 72, 0, "nothing else packed in +4");
    }

    function test_knownRootAndRootSizeSlots() public view {
        uint256 knownSlot = uint256(keccak256(abi.encode(ROOT, keccak256(abi.encode(g, SLOT_KNOWN_ROOT)))));
        uint256 sizeSlot = uint256(keccak256(abi.encode(ROOT, keccak256(abi.encode(g, SLOT_ROOT_SIZE)))));
        assertEq(uint256(_load(knownSlot)), zd.knownRoot(g, ROOT) ? 1 : 0);
        assertEq(uint256(_load(knownSlot)), 1);
        assertEq(uint256(_load(sizeSlot)), zd.rootSize(g, ROOT));
        assertEq(uint256(_load(sizeSlot)), 3);
    }

    function test_unrecordedCidReadsZero() public view {
        uint256 base = uint256(keccak256(abi.encode(keccak256("never"), SLOT_RECORDS)));
        for (uint256 i; i < 5; ++i) {
            assertEq(_load(base + i), bytes32(0));
        }
    }
}

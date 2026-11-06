// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ZeroDropStorage} from "../src/ZeroDropStorage.sol";

contract ZeroDropStorageTest is Test {
    ZeroDropStorage public storageContract;
    address public poster = address(0x1111);
    address public journalist = address(0x2222);
    address public pinner1 = address(0x3333);
    address public pinner2 = address(0x4444);

    bytes32 public constant SAMPLE_CID_DIGEST = keccak256("panama_papers_leak_part1.tar.gz");

    function setUp() public {
        storageContract = new ZeroDropStorage();
        vm.deal(poster, 100 ether);
        vm.deal(journalist, 100 ether);
    }

    function test_freeTierQuoteReturnsZero() public view {
        // Under 1 MiB is completely free
        uint256 costSmall = storageContract.quoteStorageCost(500_000, 1000);
        assertEq(costSmall, 0, "Disclosures under 1 MiB must be free");

        uint256 costExact1Mb = storageContract.quoteStorageCost(1048576, 1000);
        assertEq(costExact1Mb, 0, "Disclosures exactly 1 MiB must be free");
    }

    function test_panamaScaleQuoteCalculation() public view {
        // 51 MiB dataset for 10,000 blocks
        // excess = 50 MB => 50 * 100 wei * 10,000 = 50,000,000 wei
        uint256 sizeBytes = 51 * 1024 * 1024;
        uint256 cost = storageContract.quoteStorageCost(sizeBytes, 10_000);
        assertEq(cost, 50 * 100 * 10_000);
    }

    function test_fundStorageSuccess() public {
        uint256 panamaSize = 100 * 1024 * 1024; // 100 MB
        uint256 deposit = 1 ether;

        vm.prank(poster);
        storageContract.fundStorage{value: deposit}(SAMPLE_CID_DIGEST, panamaSize);

        (bool isFunded, uint256 balance, uint256 sizeBytes, uint256 paidUntil, uint256 remaining, uint256 pinners) =
            storageContract.getStorageStatus(SAMPLE_CID_DIGEST);

        assertTrue(isFunded);
        assertEq(balance, deposit);
        assertEq(sizeBytes, panamaSize);
        assertTrue(paidUntil > block.number);
        assertTrue(remaining > 0);
        assertEq(pinners, 0);
    }

    function test_topUpStorageExtendsRunway() public {
        uint256 size = 10 * 1024 * 1024; // 10 MB
        vm.prank(poster);
        storageContract.fundStorage{value: 0.1 ether}(SAMPLE_CID_DIGEST, size);

        (, , , uint256 paidUntilBefore, , ) = storageContract.getStorageStatus(SAMPLE_CID_DIGEST);

        // Journalist tops up storage to keep it online
        vm.prank(journalist);
        storageContract.topUpStorage{value: 0.2 ether}(SAMPLE_CID_DIGEST);

        (, uint256 balanceAfter, , uint256 paidUntilAfter, , ) = storageContract.getStorageStatus(SAMPLE_CID_DIGEST);

        assertEq(balanceAfter, 0.3 ether);
        assertTrue(paidUntilAfter > paidUntilBefore);
    }

    function test_pinnerRegistrationAndRewardClaim() public {
        uint256 size = 10 * 1024 * 1024;
        vm.prank(poster);
        storageContract.fundStorage{value: 1 ether}(SAMPLE_CID_DIGEST, size);

        // Pinners register
        vm.prank(pinner1);
        storageContract.registerPinner(SAMPLE_CID_DIGEST, "/ip4/1.2.3.4/tcp/4001/p2p/QmX");

        vm.prank(pinner2);
        storageContract.registerPinner(SAMPLE_CID_DIGEST, "/ip4/5.6.7.8/tcp/4001/p2p/QmY");

        // Fast forward 1,000 blocks
        vm.roll(block.number + 1000);

        uint256 pinner1BalBefore = pinner1.balance;
        vm.prank(pinner1);
        storageContract.claimStorageRewards(SAMPLE_CID_DIGEST);

        uint256 pinner1BalAfter = pinner1.balance;
        assertTrue(pinner1BalAfter > pinner1BalBefore, "Pinner should receive streaming reward");
    }

    function test_rejectZeroDepositOnLargeFiles() public {
        uint256 largeSize = 50 * 1024 * 1024;
        vm.prank(poster);
        vm.expectRevert(ZeroDropStorage.ZeroDeposit.selector);
        storageContract.fundStorage{value: 0}(SAMPLE_CID_DIGEST, largeSize);
    }
}


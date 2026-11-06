// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Test } from "forge-std/Test.sol";
import { ZdQuorumSpecifier } from "../src/ZdQuorumSpecifier.sol";

contract ZdQuorumSpecifierTest is Test {
    function test_specifierReturnsHashAndResolvers() public {
        bytes32 mockHash = keccak256("zd-quorum-test-bundle");
        string[] memory resolvers = new string[](2);
        resolvers[0] = "https://gateway.pinata.cloud/ipfs/bafk.../worker.js";
        resolvers[1] = "https://ipfs.io/ipfs/bafk.../worker.js";

        ZdQuorumSpecifier spec = new ZdQuorumSpecifier(mockHash, resolvers);

        assertEq(spec.workerHash(), mockHash);
        string[] memory res = spec.workerResolvers();
        assertEq(res.length, 2);
        assertEq(res[0], resolvers[0]);
        assertEq(res[1], resolvers[1]);
    }
}


// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ZdQuorumSpecifier
 * @notice Implements the Anon-RPC IWorkerSpecifier interface (§4).
 * Pins the keccak256 hash of the zd-quorum worker bundle and provides redundant resolver URLs.
 */
contract ZdQuorumSpecifier {
    bytes32 public immutable workerHash;
    string[] private _resolvers;

    event ResolversUpdated(string[] newResolvers);

    constructor(bytes32 hash_, string[] memory resolvers_) {
        workerHash = hash_;
        for (uint256 i = 0; i < resolvers_.length; i++) {
            _resolvers.push(resolvers_[i]);
        }
    }

    function workerResolvers() external view returns (string[] memory) {
        return _resolvers;
    }
}


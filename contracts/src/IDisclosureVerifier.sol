// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IDisclosureVerifier {
    function verify(
        uint256 root,
        uint256 nullifier,
        uint256 messageHash,
        uint256 scopeHash,
        uint256 depth,
        bytes calldata proof
    ) external view returns (bool);
}

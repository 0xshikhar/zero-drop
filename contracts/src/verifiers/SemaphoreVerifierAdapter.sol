// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IDisclosureVerifier} from "../IDisclosureVerifier.sol";
import {ISemaphoreVerifier} from "../vendor/semaphore/interfaces/ISemaphoreVerifier.sol";

/// @title SemaphoreVerifierAdapter
/// @notice Adapts the vendored Semaphore v4 Groth16 verifier to `IDisclosureVerifier`.
/// @dev `proof` is `abi.encode(uint256[8])` holding the Groth16 points in the packed order
///      Semaphore.sol uses: [a0, a1, b00, b01, b10, b11, c0, c1]. A proof from the
///      semaphore-protocol proof package encodes into this layout directly.
///      Public signals follow the order Semaphore.sol passes: root, nullifier, message, scope.
///      Semaphore hashes the message and scope it receives (keccak256 of the 32-byte word, shifted
///      right by 8 bits) before they become public signals. `record` passes the raw `messageOf` and
///      `scopeOf` values, so this adapter applies the same hash to them.
contract SemaphoreVerifierAdapter is IDisclosureVerifier {
    /// @dev Depth range supported by the vendored verifier key (`MIN_DEPTH`..`MAX_DEPTH`).
    uint256 public constant MIN_DEPTH = 1;
    uint256 public constant MAX_DEPTH = 32;
    uint256 public constant PROOF_BYTES = 256;

    error ZeroAddress();
    error UnsupportedDepth(uint256 depth);
    error BadProofLength(uint256 length);

    ISemaphoreVerifier public immutable semaphoreVerifier;

    constructor(address semaphoreVerifier_) {
        if (semaphoreVerifier_ == address(0)) revert ZeroAddress();
        semaphoreVerifier = ISemaphoreVerifier(semaphoreVerifier_);
    }

    function verify(
        uint256 root,
        uint256 nullifier,
        uint256 messageHash,
        uint256 scopeHash,
        uint256 depth,
        bytes calldata proof
    ) external view returns (bool) {
        if (depth < MIN_DEPTH || depth > MAX_DEPTH) revert UnsupportedDepth(depth);
        if (proof.length != PROOF_BYTES) revert BadProofLength(proof.length);

        uint256[8] memory p = abi.decode(proof, (uint256[8]));
        return semaphoreVerifier.verifyProof(
            [p[0], p[1]],
            [[p[2], p[3]], [p[4], p[5]]],
            [p[6], p[7]],
            [root, nullifier, _hash(messageHash), _hash(scopeHash)],
            depth
        );
    }

    /// @dev Same digest as Semaphore.sol `_hash`: keccak256 of the 32-byte word, shifted right by 8.
    function _hash(uint256 value) private pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(value))) >> 8;
    }
}

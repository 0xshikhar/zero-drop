// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IDisclosureVerifier} from "../IDisclosureVerifier.sol";

/// @notice Development-only verifier. Never use this for real disclosures.
/// @dev Returns true after burning about `gasToBurn` gas, to test admission of a heavy VERIFY frame without ZK.
///      The burn is a fixed number of rounds, computed in the constructor. It does NOT read `gasleft()`: the GAS
///      opcode is banned in mempool validation unless a CALL follows it immediately (docs.altmempool.wtf, rule
///      OP-011), so a `while (startGas - gasleft() < n)` loop would be rejected before its gas ever mattered.
///      Accuracy is about +-5% (see test/MockVerifier.t.sol), not exact.
contract MockVerifier is IDisclosureVerifier {
    /// @dev Measured cost of one loop round (MSTORE + KECCAK256 + loop bookkeeping), see the test.
    uint256 internal constant GAS_PER_ROUND = 103;

    uint256 public immutable gasToBurn;
    uint256 public immutable rounds;

    constructor(uint256 gasToBurn_) {
        gasToBurn = gasToBurn_;
        rounds = gasToBurn_ / GAS_PER_ROUND;
    }

    function verify(uint256, uint256, uint256, uint256, uint256, bytes calldata) external view returns (bool) {
        uint256 n = rounds;
        uint256 acc = 1;
        assembly ("memory-safe") {
            for { let i := 0 } lt(i, n) { i := add(i, 1) } {
                mstore(0, acc)
                acc := keccak256(0, 32)
            }
        }
        // `acc` is a hash, so this is never taken; it keeps the loop from being optimised away.
        return acc != 0 || n == 0;
    }
}

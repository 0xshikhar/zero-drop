// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// The devnets HegotaSupport knows. Each value has a directory of the same name in `yul/` (kebab-case there).
/// A new devnet is appended, never inserted, so existing values keep their number.
enum Devnet {
    /// The public alt-mempool devnet (chain 1337): ethrex `eip8141-tracer` plus the Skandha alt-mempool.
    ERC8421_WORKSHOP,
    /// The ethrex Hegota devnet of the EIP-7906 assertions workshop (chain 3151908).
    EIP7906_WORKSHOP
}

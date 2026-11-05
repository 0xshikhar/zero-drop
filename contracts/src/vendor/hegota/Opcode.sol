// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// The opcodes HegotaSupport wraps. Each value has a Yul helper file of the same name per devnet that has it:
/// `yul/<devnet>/<Opcode>.yul`. A devnet without the file does not have the opcode.
enum Opcode {
    // EIP-8141
    Approve,
    TxParam,
    FrameDataLoad,
    FrameDataCopy,
    FrameParam,
    SigParam,
    SigDataCopy,
    // EIP-7906
    TxTrace,
    EventDataCopy
}

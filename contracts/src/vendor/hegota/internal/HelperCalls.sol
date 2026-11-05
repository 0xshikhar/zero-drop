// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// How HegotaSupport talks to a Yul helper: the operands go in as consecutive 32-byte words, there is no selector.
/// A failing helper reverts with its own revert data, so the caller sees what the opcode did.
library HelperCalls {
    /// For opcodes that read: staticcall, so a `view` function can use them. Returns the helper's raw output.
    function read(address helper, bytes memory operands) internal view returns (bytes memory output) {
        bool ok;
        (ok, output) = helper.staticcall(operands);
        if (!ok) _bubble(output);
    }

    /// For opcodes that read and answer with one word.
    function readWord(address helper, bytes memory operands) internal view returns (uint256 word) {
        bytes memory output = read(helper, operands);
        if (output.length != 32) revert UnexpectedOutputLength(output.length);
        word = abi.decode(output, (uint256));
    }

    /// For opcodes that act on the executing account (APPROVE): delegatecall, so the helper runs as the caller.
    function act(address helper, bytes memory operands) internal {
        (bool ok, bytes memory output) = helper.delegatecall(operands);
        if (!ok) _bubble(output);
    }

    error UnexpectedOutputLength(uint256 length);

    function _bubble(bytes memory revertData) private pure {
        assembly ("memory-safe") {
            revert(add(revertData, 0x20), mload(revertData))
        }
    }
}

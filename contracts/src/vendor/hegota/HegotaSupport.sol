// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Imported here and so importable from this file: a contract needs one import for the base and the names it passes
// to its functions, e.g. `import {HegotaSupport, Devnet, TxTrace} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";`.
import {Devnet} from "./Devnet.sol";
import {Opcode} from "./Opcode.sol";
import {Scope, TxParam, FrameParam, FrameMode, SigParam, TxTrace} from "./Params.sol";
import {HelperCalls} from "./internal/HelperCalls.sol";
import {HelperCode} from "./generated/HelperCode.sol";

/// The Hegota frame opcodes as Solidity functions.
///
/// Solidity cannot emit these opcodes, so each one is a small Yul contract (`yul/<devnet>/<Opcode>.yul`) that the
/// constructor deploys, once per inheriting contract, and keeps as an immutable address. Every function here takes
/// the opcode's own operands, in the order of the EIP's stack table (top of the stack first), minus operands that
/// only mean something inside a Yul helper (the destination of a copy, the return range of APPROVE).
///
/// Inherit it; do not deploy it on its own and call it. APPROVE acts on the account that executes it, which has to
/// be your contract, and that is only true for a contract that inherits this one:
///
///     contract MyPaymaster is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
///         fallback() external { approve(Scope.PAYMENT); }
///     }
///
/// An opcode the chosen devnet does not have reverts with OpcodeUnsupported.
abstract contract HegotaSupport {
    // -------------------------------------------------------------------------------------------- state ----------

    /// The devnet this contract was built for.
    Devnet internal immutable DEVNET;

    // One deployed helper per opcode; address(0) where the devnet does not have the opcode.
    address private immutable _APPROVE_HELPER;
    address private immutable _TX_PARAM_HELPER;
    address private immutable _FRAME_DATA_LOAD_HELPER;
    address private immutable _FRAME_DATA_COPY_HELPER;
    address private immutable _FRAME_PARAM_HELPER;
    address private immutable _SIG_PARAM_HELPER;
    address private immutable _SIG_DATA_COPY_HELPER;
    address private immutable _TX_TRACE_HELPER;
    address private immutable _EVENT_DATA_COPY_HELPER;

    error OpcodeUnsupported(Devnet devnet, Opcode opcode);
    error HelperDeploymentFailed(Devnet devnet, Opcode opcode);

    constructor(Devnet devnet) {
        DEVNET = devnet;
        _APPROVE_HELPER = _deploy(devnet, Opcode.Approve, HelperCode.approve(devnet));
        _TX_PARAM_HELPER = _deploy(devnet, Opcode.TxParam, HelperCode.txParam(devnet));
        _FRAME_DATA_LOAD_HELPER = _deploy(devnet, Opcode.FrameDataLoad, HelperCode.frameDataLoad(devnet));
        _FRAME_DATA_COPY_HELPER = _deploy(devnet, Opcode.FrameDataCopy, HelperCode.frameDataCopy(devnet));
        _FRAME_PARAM_HELPER = _deploy(devnet, Opcode.FrameParam, HelperCode.frameParam(devnet));
        _SIG_PARAM_HELPER = _deploy(devnet, Opcode.SigParam, HelperCode.sigParam(devnet));
        _SIG_DATA_COPY_HELPER = _deploy(devnet, Opcode.SigDataCopy, HelperCode.sigDataCopy(devnet));
        _TX_TRACE_HELPER = _deploy(devnet, Opcode.TxTrace, HelperCode.txTrace(devnet));
        _EVENT_DATA_COPY_HELPER = _deploy(devnet, Opcode.EventDataCopy, HelperCode.eventDataCopy(devnet));
    }

    // ------------------------------------------------------------------------------------------ EIP-8141 ----------

    /// APPROVE (0xaa). Approves the frame's scope on behalf of this contract and ends the frame.
    function approve(Scope scope) internal {
        HelperCalls.act(_helper(_APPROVE_HELPER, Opcode.Approve), abi.encode(scope));
    }

    /// TXPARAM (0xb0). A field of the transaction.
    function txparam(TxParam param) internal view returns (uint256) {
        return HelperCalls.readWord(_helper(_TX_PARAM_HELPER, Opcode.TxParam), abi.encode(param));
    }

    /// FRAMEDATALOAD (0xb1). The 32-byte word at `offset` of frame `frameIndex`'s data.
    function framedataload(uint256 offset, uint256 frameIndex) internal view returns (bytes32) {
        return bytes32(
            HelperCalls.readWord(_helper(_FRAME_DATA_LOAD_HELPER, Opcode.FrameDataLoad), abi.encode(offset, frameIndex))
        );
    }

    /// FRAMEDATACOPY (0xb2). `length` bytes of frame `frameIndex`'s data, from `dataOffset`.
    function framedatacopy(uint256 dataOffset, uint256 length, uint256 frameIndex)
        internal
        view
        returns (bytes memory)
    {
        return HelperCalls.read(
            _helper(_FRAME_DATA_COPY_HELPER, Opcode.FrameDataCopy), abi.encode(dataOffset, length, frameIndex)
        );
    }

    /// FRAMEPARAM (0xb3). A field of frame `frameIndex`.
    function frameparam(uint256 frameIndex, FrameParam param) internal view returns (uint256) {
        return HelperCalls.readWord(_helper(_FRAME_PARAM_HELPER, Opcode.FrameParam), abi.encode(frameIndex, param));
    }

    /// SIGPARAM (0xb4). A field of signature entry `signatureIndex`.
    function sigparam(uint256 signatureIndex, SigParam param) internal view returns (uint256) {
        return HelperCalls.readWord(_helper(_SIG_PARAM_HELPER, Opcode.SigParam), abi.encode(signatureIndex, param));
    }

    /// SIGDATACOPY (0xb5). `length` bytes of signature entry `signatureIndex`, from `dataOffset`.
    function sigdatacopy(uint256 dataOffset, uint256 length, uint256 signatureIndex)
        internal
        view
        returns (bytes memory)
    {
        return HelperCalls.read(
            _helper(_SIG_DATA_COPY_HELPER, Opcode.SigDataCopy), abi.encode(dataOffset, length, signatureIndex)
        );
    }

    // ------------------------------------------------------------------------------------------ EIP-7906 ----------

    /// TXTRACE (0xb6). What the transaction did, readable inside a POST_TX frame. `in2` is the index the `param`
    /// refers to (which balance, slot or event); `in2` comes first because it is the opcode's top stack operand.
    function txtrace(uint256 in2, TxTrace param) internal view returns (uint256) {
        return HelperCalls.readWord(_helper(_TX_TRACE_HELPER, Opcode.TxTrace), abi.encode(in2, param));
    }

    /// EVENTDATACOPY (0xb7). `length` bytes of event `eventIndex`'s data, from `dataOffset`. POST_TX frames only.
    function eventdatacopy(uint256 eventIndex, uint256 dataOffset, uint256 length)
        internal
        view
        returns (bytes memory)
    {
        return HelperCalls.read(
            _helper(_EVENT_DATA_COPY_HELPER, Opcode.EventDataCopy), abi.encode(eventIndex, dataOffset, length)
        );
    }

    // ------------------------------------------------------------------------------------------ internals ---------

    /// Deploys a helper from its creation code; `address(0)` when the devnet has no such opcode (empty code).
    function _deploy(Devnet devnet, Opcode opcode, bytes memory creationCode) private returns (address helper) {
        if (creationCode.length == 0) return address(0);
        assembly ("memory-safe") {
            helper := create(0, add(creationCode, 0x20), mload(creationCode))
        }
        if (helper == address(0)) revert HelperDeploymentFailed(devnet, opcode);
    }

    /// The helper to call, or a revert naming the opcode this devnet lacks.
    function _helper(address helper, Opcode opcode) private view returns (address) {
        if (helper == address(0)) revert OpcodeUnsupported(DEVNET, opcode);
        return helper;
    }
}

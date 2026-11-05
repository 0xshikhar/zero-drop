// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title DisclosureFrameChecks
/// @notice Pure shape checks for the EIP-8141 disclosure transaction. Each rule reverts with its
///         own error so the failing path is named. A VERIFY frame calls `check` before approving.
/// @dev Shape of the disclosure transaction (see docs/architecture.md section 4):
///      frames[0] = VERIFY (this check), frames[1] = SENDER -> ZeroDrop.record(...).
///      The library does not read frame data itself. The caller passes it in.
library DisclosureFrameChecks {
    /// @dev A disclosure has exactly two frames: VERIFY, then the SENDER body.
    uint256 internal constant FRAME_COUNT = 2;

    /// @dev Floor for the body frame's execution gas, so a member cannot starve it and leave the
    ///      payer paying for a failed record. Raised from the 150k in docs/architecture.md: a
    ///      record() with a real Semaphore Groth16 proof (depth 2) measured ~395k gas in
    ///      test/SemaphoreVerifierAdapter.t.sol, and the adapter test asserts this floor covers it.
    uint256 internal constant MIN_BODY_GAS = 450_000;

    /// @dev Fee cap per disclosure: 0.01 ether-equivalent in wei (1e16). Stops fee inflation.
    uint256 internal constant MAX_COST_CAP = 0.01 ether;

    /// @dev Selector of ZeroDrop.record(uint256,bytes32,bytes32,uint256,uint256,uint256,bytes).
    bytes4 internal constant RECORD_SELECTOR =
        bytes4(keccak256("record(uint256,bytes32,bytes32,uint256,uint256,uint256,bytes)"));

    error FrameCountMismatch(uint256 actual);
    error FrameTargetMismatch(address actual, address expected);
    error FrameValueNonZero(uint256 value);
    error SelectorMismatch(bytes4 actual, bytes4 expected);
    error BodyGasTooLow(uint256 actual, uint256 minimum);
    error MaxCostTooHigh(uint256 actual, uint256 cap);
    error RootUnknown();
    error NullifierZero();

    /// @notice Shape of a disclosure transaction, as read by the VERIFY frame.
    struct Shape {
        uint256 frameCount;
        /// @dev Target of frame 1 (the SENDER body frame).
        address senderTarget;
        /// @dev Value sent by frame 1.
        uint256 senderValue;
        /// @dev First four bytes of frame 1's calldata.
        bytes4 selector;
        /// @dev Execution gas limit of frame 1.
        uint256 senderExecutionGas;
        /// @dev Maximum total fee of the transaction, in wei.
        uint256 maxCost;
        /// @dev `knownRoot[groupId][root]` read on ZeroDrop.
        bool rootKnown;
        /// @dev Nullifier carried in the transaction's nonce key.
        uint256 nullifier;
        /// @dev Deployed ZeroDrop address the body frame must target.
        address expectedTarget;
    }

    /// @notice Reverts with a named error for the first rule the shape breaks.
    /// @dev Rules run in the order of the architecture doc: frame count, frame 1 target, value,
    ///      selector, body gas, cost cap, root known, nullifier nonzero.
    function check(Shape memory s) internal pure {
        if (s.frameCount != FRAME_COUNT) revert FrameCountMismatch(s.frameCount);
        if (s.senderTarget != s.expectedTarget) revert FrameTargetMismatch(s.senderTarget, s.expectedTarget);
        if (s.senderValue != 0) revert FrameValueNonZero(s.senderValue);
        if (s.selector != RECORD_SELECTOR) revert SelectorMismatch(s.selector, RECORD_SELECTOR);
        if (s.senderExecutionGas < MIN_BODY_GAS) revert BodyGasTooLow(s.senderExecutionGas, MIN_BODY_GAS);
        if (s.maxCost > MAX_COST_CAP) revert MaxCostTooHigh(s.maxCost, MAX_COST_CAP);
        if (!s.rootKnown) revert RootUnknown();
        if (s.nullifier == 0) revert NullifierZero();
    }
}

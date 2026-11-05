// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Parameter ids of the introspection opcodes, named as in the EIPs. Every member's number is its id: an id the EIP
// does not assign is kept as an UNASSIGNED_<hex> member, so `uint256(TxParam.NONCE) == 0x01` holds throughout.

/// What `approve` approves. The numbers are the low bits of a frame's flags.
enum Scope {
    NONE,
    PAYMENT,
    EXECUTION,
    EXECUTION_AND_PAYMENT
}

/// The mode of a frame, as `frameparam(i, FrameParam.MODE)` reports it. POST_TX exists on the EIP-7906 devnet only
/// (the current EIP-7906 text calls the mode ASSERT).
enum FrameMode {
    DEFAULT,
    VERIFY,
    SENDER,
    POST_TX
}

/// EIP-8141 TXPARAM ids, with the keyed-nonce ids 0x0d to 0x10 of EIP-8250.
enum TxParam {
    TYPE,
    NONCE,
    SENDER,
    MAX_PRIORITY_FEE_PER_GAS,
    MAX_FEE,
    UNASSIGNED_05, // not listed in the EIP text
    MAX_COST, // not in the EIP text: ethrex answers 0x06 with the transaction's maximum cost
    BLOB_COUNT,
    SIG_HASH,
    FRAME_COUNT,
    CURRENT_FRAME_INDEX,
    SIGNATURE_COUNT,
    STATE_GAS_LEFT,
    LEGACY_NONCE,
    NONCE_KEY_COUNT,
    NONCE_KEYS_HASH,
    NONCE_KEY_0
}

/// EIP-8141 FRAMEPARAM ids.
enum FrameParam {
    RESOLVED_TARGET,
    EXECUTION_GAS_LIMIT,
    MODE,
    FLAGS,
    DATA_LENGTH,
    STATUS,
    ALLOWED_SCOPE,
    ATOMIC_BATCH,
    VALUE,
    STATE_GAS_LIMIT,
    EXECUTION_GAS_USED,
    STATE_GAS_USED
}

/// EIP-8141 SIGPARAM ids.
enum SigParam {
    RESOLVED_SIGNER,
    SCHEME,
    MSG,
    SIGNATURE_LENGTH
}

/// EIP-7906 TXTRACE ids, as the ethrex Hegota devnet implements them.
enum TxTrace {
    BALANCES_CHANGED,
    SLOTS_CHANGED,
    CODES_DEPLOYED,
    BALANCE_ADDRESS,
    BALANCE_BEFORE,
    BALANCE_AFTER,
    SLOT_ADDRESS,
    SLOT_KEY,
    SLOT_BEFORE,
    SLOT_AFTER,
    UNASSIGNED_0A,
    UNASSIGNED_0B,
    EVENTS_COUNT,
    EVENT_ADDRESS,
    EVENT_TOPIC_COUNT,
    EVENT_TOPIC0,
    EVENT_TOPIC1,
    EVENT_TOPIC2,
    UNASSIGNED_12,
    EVENT_DATA_LENGTH,
    GAS_PRECHARGE,
    GAS_PAYER
}

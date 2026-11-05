// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Staking registry of the alt-mempool devnet (`NaiveStakingRegistry` implements it). Everything is keyed by
///         `msg.sender`, so a contract that wants to be a staked entity must call `addStake` itself.
/// @dev Interface copied from https://docs.altmempool.wtf/concepts/entities-and-stake/ (checked 2026-11-06).
///      Devnet registry address (can change when the devnet resets): 0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f.
///      Stake must be strictly greater than the node's `minStake` (0.01 ETH on the devnet, the workshop uses 0.012 ETH)
///      with an unstake delay of at least 86400 seconds.
interface IStakingRegistry {
    /// @notice Lock `msg.value` as the caller's stake, with the given unstake delay.
    function addStake(uint32 unstakeDelaySec) external payable;

    /// @notice Begin the withdrawal delay. From this point the caller is not considered to be staked.
    function unlockStake() external;

    /// @notice Withdraw the stake after the delay has passed.
    function withdrawStake(address payable withdrawAddress) external;

    /// @notice Return the stake information.
    function getDepositInfo(address account)
        external
        view
        returns (uint256 stake, uint32 unstakeDelaySec, uint64 withdrawTime);
}

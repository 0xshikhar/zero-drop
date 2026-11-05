// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IDisclosureVerifier} from "../IDisclosureVerifier.sol";

/// @notice Development-only verifier. Never use this for real disclosures.
contract MockVerifier is IDisclosureVerifier {
    uint256 public immutable gasToBurn;

    constructor(uint256 gasToBurn_) {
        gasToBurn = gasToBurn_;
    }

    function verify(uint256, uint256, uint256, uint256, uint256, bytes calldata)
        external
        view
        returns (bool)
    {
        uint256 startGas = gasleft();
        while (startGas - gasleft() < gasToBurn) {
            // Deliberately consume gas for admission testing only.
        }
        return true;
    }
}

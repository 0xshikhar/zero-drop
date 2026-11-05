// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockVerifier} from "../src/verifiers/MockVerifier.sol";

contract MockVerifierTest is Test {
    function _burned(uint256 target) internal returns (uint256 used) {
        MockVerifier m = new MockVerifier(target);
        uint256 before = gasleft();
        bool ok = m.verify(1, 2, 3, 4, 5, "");
        used = before - gasleft();
        assertTrue(ok);
    }

    function test_burnsRoughlyTheRequestedGas() public {
        uint256[3] memory targets = [uint256(100_000), 300_000, 1_000_000];
        for (uint256 i; i < targets.length; ++i) {
            uint256 used = _burned(targets[i]);
            emit log_named_uint("target", targets[i]);
            emit log_named_uint("used", used);
            assertGt(used, targets[i] * 95 / 100, "burns too little");
            assertLt(used, targets[i] * 105 / 100 + 2_000, "burns too much");
        }
    }

    function test_zeroBurnStillReturnsTrue() public {
        assertLt(_burned(0), 5_000);
    }

    function test_doesNotUseTheGasOpcode() public {
        // OP-011: GAS is banned in validation unless a CALL follows. Runtime code must not contain 0x5a at all
        // outside of the CALL-adjacent pattern; the mock has no calls, so there must be none.
        MockVerifier m = new MockVerifier(300_000);
        bytes memory code = address(m).code;
        for (uint256 i; i < code.length; ++i) {
            if (code[i] == 0x5a) {
                // 0x5a may also be PUSH data; reject only when it is not inside a PUSH operand.
                assertTrue(_insidePushData(code, i), "GAS opcode present");
            }
        }
    }

    function _insidePushData(bytes memory code, uint256 index) internal pure returns (bool) {
        uint256 i;
        while (i < code.length) {
            uint8 op = uint8(code[i]);
            uint256 width = (op >= 0x60 && op <= 0x7f) ? op - 0x5f : 0;
            if (index > i && index <= i + width) return true;
            if (index == i) return false;
            i += 1 + width;
        }
        return false;
    }
}

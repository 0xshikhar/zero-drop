// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ZeroDrop} from "../src/ZeroDrop.sol";
import {DisclosureFrameChecks} from "../src/frame/DisclosureFrameChecks.sol";

/// @dev Exposes the internal library function as an external call so vm.expectRevert can catch it.
contract FrameCheckHarness {
    function check(DisclosureFrameChecks.Shape calldata s) external pure {
        DisclosureFrameChecks.check(s);
    }
}

contract DisclosureFrameChecksTest is Test {
    FrameCheckHarness internal h;
    address internal zeroDrop = address(0x2D0);
    address internal other = address(0xBAD);

    function setUp() public {
        h = new FrameCheckHarness();
    }

    function _valid() internal view returns (DisclosureFrameChecks.Shape memory s) {
        s = DisclosureFrameChecks.Shape({
            frameCount: 2,
            senderTarget: zeroDrop,
            senderValue: 0,
            selector: ZeroDrop.record.selector,
            senderExecutionGas: DisclosureFrameChecks.MIN_BODY_GAS,
            maxCost: DisclosureFrameChecks.MAX_COST_CAP,
            rootKnown: true,
            nullifier: 1,
            expectedTarget: zeroDrop
        });
    }

    function test_constants() public pure {
        assertEq(DisclosureFrameChecks.FRAME_COUNT, 2);
        assertEq(DisclosureFrameChecks.MIN_BODY_GAS, 450_000);
        assertEq(DisclosureFrameChecks.MAX_COST_CAP, 1e16);
        assertEq(DisclosureFrameChecks.RECORD_SELECTOR, ZeroDrop.record.selector);
    }

    function test_validShapePasses() public view {
        h.check(_valid());
    }

    function test_frameCountMustBeTwo() public {
        DisclosureFrameChecks.Shape memory s = _valid();
        s.frameCount = 1;
        vm.expectRevert(abi.encodeWithSelector(DisclosureFrameChecks.FrameCountMismatch.selector, 1));
        h.check(s);

        s.frameCount = 3;
        vm.expectRevert(abi.encodeWithSelector(DisclosureFrameChecks.FrameCountMismatch.selector, 3));
        h.check(s);
    }

    function test_frameOneTargetMustBeZeroDrop() public {
        DisclosureFrameChecks.Shape memory s = _valid();
        s.senderTarget = other;
        vm.expectRevert(
            abi.encodeWithSelector(DisclosureFrameChecks.FrameTargetMismatch.selector, other, zeroDrop)
        );
        h.check(s);
    }

    function test_frameValueMustBeZero() public {
        DisclosureFrameChecks.Shape memory s = _valid();
        s.senderValue = 1;
        vm.expectRevert(abi.encodeWithSelector(DisclosureFrameChecks.FrameValueNonZero.selector, 1));
        h.check(s);
    }

    function test_selectorMustBeRecord() public {
        DisclosureFrameChecks.Shape memory s = _valid();
        bytes4 wrong = ZeroDrop.messageOf.selector;
        s.selector = wrong;
        vm.expectRevert(
            abi.encodeWithSelector(DisclosureFrameChecks.SelectorMismatch.selector, wrong, ZeroDrop.record.selector)
        );
        h.check(s);
    }

    function test_bodyGasFloor() public {
        DisclosureFrameChecks.Shape memory s = _valid();
        s.senderExecutionGas = DisclosureFrameChecks.MIN_BODY_GAS - 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                DisclosureFrameChecks.BodyGasTooLow.selector, DisclosureFrameChecks.MIN_BODY_GAS - 1, DisclosureFrameChecks.MIN_BODY_GAS
            )
        );
        h.check(s);

        s.senderExecutionGas = DisclosureFrameChecks.MIN_BODY_GAS;
        h.check(s);
    }

    function test_maxCostCap() public {
        DisclosureFrameChecks.Shape memory s = _valid();
        s.maxCost = DisclosureFrameChecks.MAX_COST_CAP + 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                DisclosureFrameChecks.MaxCostTooHigh.selector, DisclosureFrameChecks.MAX_COST_CAP + 1, DisclosureFrameChecks.MAX_COST_CAP
            )
        );
        h.check(s);

        s.maxCost = DisclosureFrameChecks.MAX_COST_CAP;
        h.check(s);
    }

    function test_rootMustBeKnown() public {
        DisclosureFrameChecks.Shape memory s = _valid();
        s.rootKnown = false;
        vm.expectRevert(DisclosureFrameChecks.RootUnknown.selector);
        h.check(s);
    }

    function test_nullifierMustBeNonZero() public {
        DisclosureFrameChecks.Shape memory s = _valid();
        s.nullifier = 0;
        vm.expectRevert(DisclosureFrameChecks.NullifierZero.selector);
        h.check(s);
    }
}

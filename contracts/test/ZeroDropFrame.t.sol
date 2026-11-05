// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {ZeroDrop} from "../src/ZeroDrop.sol";
import {IStakingRegistry} from "../src/IStakingRegistry.sol";
import {IDisclosureVerifier} from "../src/IDisclosureVerifier.sol";
import {MockVerifier} from "../src/verifiers/MockVerifier.sol";
import {SemaphoreVerifierAdapter} from "../src/verifiers/SemaphoreVerifierAdapter.sol";
import {SemaphoreVerifier} from "../src/vendor/semaphore/base/SemaphoreVerifier.sol";
import {DisclosureFrameChecks} from "../src/frame/DisclosureFrameChecks.sol";
import {TxParam, FrameParam, FrameMode, Scope} from "../src/vendor/hegota/Params.sol";

// ----------------------------------------------------------------------------------------------------------------
// Forge cannot run the frame opcodes. These mocks are etched over the helper contracts that HegotaSupport deploys
// with CREATE, so the tests below drive ZeroDrop.fallback() through its real code with scripted opcode answers.
// They prove wiring and check order. They prove nothing about what a frame-capable node answers.
// ----------------------------------------------------------------------------------------------------------------

/// @dev Stands in for the TXPARAM and FRAMEPARAM helpers: the answer is looked up by keccak256(operands).
contract KeyedWordMock {
    mapping(bytes32 => uint256) public words;

    function set(bytes32 key, uint256 value) external {
        words[key] = value;
    }

    fallback(bytes calldata operands) external returns (bytes memory) {
        return abi.encode(words[keccak256(operands)]);
    }
}

/// @dev Stands in for the FRAMEDATALOAD (64 byte operands) and FRAMEDATACOPY (96 byte operands) helpers.
///      Frame index is ignored: the scripted data is frame 1's.
contract FrameDataMock {
    bytes public data;

    function setData(bytes calldata d) external {
        data = d;
    }

    fallback(bytes calldata operands) external returns (bytes memory) {
        if (operands.length == 64) {
            (uint256 offset,) = abi.decode(operands, (uint256, uint256));
            return abi.encode(_word(offset));
        }
        (uint256 dataOffset, uint256 length,) = abi.decode(operands, (uint256, uint256, uint256));
        bytes memory out = new bytes(length);
        for (uint256 i; i < length; ++i) {
            out[i] = dataOffset + i < data.length ? data[dataOffset + i] : bytes1(0);
        }
        return out;
    }

    function _word(uint256 offset) private view returns (bytes32 w) {
        for (uint256 i; i < 32; ++i) {
            bytes1 b = offset + i < data.length ? data[offset + i] : bytes1(0);
            w |= bytes32(b) >> (8 * i);
        }
    }
}

/// @dev APPROVE helper: ZeroDrop delegatecalls it, so the event comes from ZeroDrop's address.
contract ApproveMock {
    event Approved(uint256 scope);

    fallback(bytes calldata operands) external returns (bytes memory) {
        emit Approved(abi.decode(operands, (uint256)));
        return "";
    }
}

contract MockRegistry is IStakingRegistry {
    uint256 public stakedValue;
    uint32 public delay;
    address public lastCaller;
    address public withdrewTo;
    bool public unlocked;

    function addStake(uint32 unstakeDelaySec) external payable {
        stakedValue += msg.value;
        delay = unstakeDelaySec;
        lastCaller = msg.sender;
    }

    function unlockStake() external {
        unlocked = true;
        lastCaller = msg.sender;
    }

    function withdrawStake(address payable to) external {
        withdrewTo = to;
        lastCaller = msg.sender;
    }

    function getDepositInfo(address) external view returns (uint256, uint32, uint64) {
        return (stakedValue, delay, 0);
    }
}

contract ZeroDropFrameTest is Test {
    address internal constant ENTRY = address(0xaa);
    string internal constant FIXTURE = "test/fixtures/semaphore-proof.json";

    // Helper creation order inside HegotaSupport's constructor (ERC8421_WORKSHOP has these seven opcodes).
    uint256 internal constant N_APPROVE = 1;
    uint256 internal constant N_TXPARAM = 2;
    uint256 internal constant N_FRAMEDATALOAD = 3;
    uint256 internal constant N_FRAMEDATACOPY = 4;
    uint256 internal constant N_FRAMEPARAM = 5;
    uint256 internal constant N_SIGPARAM = 6;
    uint256 internal constant N_SIGDATACOPY = 7;

    ZeroDrop internal zd;
    MockRegistry internal registry;
    MockVerifier internal mock;

    address internal alice = makeAddr("alice");
    bytes32 internal constant CASE = keccak256("case-a");
    bytes32 internal constant CID = keccak256("cid-1");
    uint256 internal constant ROOT = 777;
    uint256 internal constant NULLIFIER = 4242;
    uint256 internal constant DEPTH = 2;
    bytes internal proofBytes = new bytes(256);

    event Approved(uint256 scope);

    function setUp() public {
        registry = new MockRegistry();
        zd = new ZeroDrop(false, address(registry));
        mock = new MockVerifier(0);
        zd.setVerifier(address(mock));
    }

    // ---------------------------------------------------------------- scripting helpers

    function _helper(uint256 nonce) internal view returns (address) {
        return vm.computeCreateAddress(address(zd), nonce);
    }

    function _etchFrameMocks(ZeroDrop target) internal {
        vm.etch(vm.computeCreateAddress(address(target), N_APPROVE), address(new ApproveMock()).code);
        address words = address(new KeyedWordMock());
        vm.etch(vm.computeCreateAddress(address(target), N_TXPARAM), words.code);
        vm.etch(vm.computeCreateAddress(address(target), N_FRAMEPARAM), words.code);
        address data = address(new FrameDataMock());
        vm.etch(vm.computeCreateAddress(address(target), N_FRAMEDATALOAD), data.code);
        vm.etch(vm.computeCreateAddress(address(target), N_FRAMEDATACOPY), data.code);
    }

    function _setTx(ZeroDrop target, TxParam p, uint256 v) internal {
        KeyedWordMock(vm.computeCreateAddress(address(target), N_TXPARAM)).set(keccak256(abi.encode(p)), v);
    }

    function _setFrame(ZeroDrop target, uint256 idx, FrameParam p, uint256 v) internal {
        KeyedWordMock(vm.computeCreateAddress(address(target), N_FRAMEPARAM)).set(keccak256(abi.encode(idx, p)), v);
    }

    function _setData(ZeroDrop target, bytes memory d) internal {
        FrameDataMock(vm.computeCreateAddress(address(target), N_FRAMEDATALOAD)).setData(d);
        FrameDataMock(vm.computeCreateAddress(address(target), N_FRAMEDATACOPY)).setData(d);
        _setFrame(target, 1, FrameParam.DATA_LENGTH, d.length);
    }

    function _recordData(
        uint256 g,
        bytes32 caseId,
        bytes32 cid,
        uint256 root,
        uint256 nullifier,
        uint256 depth,
        bytes memory proof
    ) internal pure returns (bytes memory) {
        return abi.encodeCall(ZeroDrop.record, (g, caseId, cid, root, nullifier, depth, proof));
    }

    /// @dev A well-formed disclosure transaction as the opcodes would report it.
    function _script(ZeroDrop target, uint256 g, bytes32 cid, uint256 root, uint256 nullifier, bytes memory proof)
        internal
    {
        _etchFrameMocks(target);
        _setTx(target, TxParam.FRAME_COUNT, 2);
        _setTx(target, TxParam.MAX_COST, 1e15);
        _setTx(target, TxParam.NONCE_KEY_0, nullifier);
        _setFrame(target, 1, FrameParam.MODE, uint256(FrameMode.SENDER));
        _setFrame(target, 1, FrameParam.RESOLVED_TARGET, uint256(uint160(address(target))));
        _setFrame(target, 1, FrameParam.VALUE, 0);
        _setFrame(target, 1, FrameParam.EXECUTION_GAS_LIMIT, DisclosureFrameChecks.MIN_BODY_GAS);
        _setData(target, _recordData(g, CASE, cid, root, nullifier, DEPTH, proof));
    }

    function _group() internal returns (uint256 g) {
        g = zd.createGroup(2);
        uint256[] memory c = new uint256[](3);
        c[0] = 1;
        c[1] = 2;
        c[2] = 3;
        zd.addMembers(g, c, ROOT);
    }

    function _verify() internal returns (bool ok, bytes memory ret) {
        vm.prank(ENTRY);
        (ok, ret) = address(zd).call("");
    }

    function _expectVerifyRevert(bytes memory reason) internal {
        vm.prank(ENTRY);
        vm.expectRevert(reason);
        (bool ok,) = address(zd).call("");
        ok;
    }

    // ---------------------------------------------------------------- wiring

    function test_constructor_deploysSevenHelpersForTheWorkshopDevnet() public view {
        // APPROVE 0xaa, TXPARAM 0xb0, FRAMEDATALOAD 0xb1, FRAMEPARAM 0xb3, SIGPARAM 0xb4 live in these helpers.
        assertEq(_helper(N_APPROVE).code, hex"600035600080aa");
        assertEq(_helper(N_TXPARAM).code, hex"600035b060005260206000f3");
        assertEq(_helper(N_FRAMEDATALOAD).code, hex"602035600035b160005260206000f3");
        assertEq(_helper(N_FRAMEDATACOPY).code, hex"6040356020356000356000b26020356000f3");
        assertEq(_helper(N_FRAMEPARAM).code, hex"602035600035b360005260206000f3");
        assertEq(_helper(N_SIGPARAM).code, hex"602035600035b460005260206000f3");
        assertEq(_helper(N_SIGDATACOPY).code, hex"6040356020356000356000b56020356000f3");
        // TXTRACE and EVENTDATACOPY exist on the other devnet only.
        assertEq(_helper(8).code.length, 0);
    }

    function test_constructor_storesConfiguration() public {
        assertEq(zd.owner(), address(this));
        assertFalse(zd.directRecordEnabled());
        assertEq(address(zd.stakingRegistry()), address(registry));
        assertEq(zd.FRAME_ENTRY_POINT(), ENTRY);

        ZeroDrop local = new ZeroDrop(true, address(0));
        assertTrue(local.directRecordEnabled());
        assertEq(address(local.stakingRegistry()), address(0));
    }

    // ---------------------------------------------------------------- direct path toggle

    function test_record_directPathDisabled_revertsForOutsiders() public {
        uint256 g = _group();
        vm.prank(alice);
        vm.expectRevert(ZeroDrop.DirectRecordDisabled.selector);
        zd.record(g, CASE, CID, ROOT, NULLIFIER, DEPTH, proofBytes);
    }

    function test_record_directPathDisabled_allowsSelfCall() public {
        uint256 g = _group();
        vm.prank(address(zd)); // what the SENDER frame does in a self-relay transaction
        zd.record(g, CASE, CID, ROOT, NULLIFIER, DEPTH, proofBytes);
        (,,,,, bool exists) = zd.records(CID);
        assertTrue(exists);
    }

    function test_record_directPathEnabled_allowsOutsiders() public {
        ZeroDrop local = new ZeroDrop(true, address(0));
        local.setVerifier(address(mock));
        uint256 g = local.createGroup(2);
        uint256[] memory c = new uint256[](2);
        c[0] = 1;
        c[1] = 2;
        local.addMembers(g, c, ROOT);
        vm.prank(alice);
        local.record(g, CASE, CID, ROOT, NULLIFIER, DEPTH, proofBytes);
        (,,,,, bool exists) = local.records(CID);
        assertTrue(exists);
    }

    // ---------------------------------------------------------------- stake

    function test_stake_onlyOwner() public {
        vm.deal(address(zd), 1 ether);
        vm.startPrank(alice);
        vm.expectRevert(ZeroDrop.NotOwner.selector);
        zd.stake(86400, 0.012 ether);
        vm.expectRevert(ZeroDrop.NotOwner.selector);
        zd.unlockStake();
        vm.expectRevert(ZeroDrop.NotOwner.selector);
        zd.withdrawStake(payable(alice));
        vm.stopPrank();
    }

    function test_stake_forwardsFloatToRegistryAsTheContract() public {
        vm.deal(address(zd), 1 ether);
        zd.stake(86400, 0.012 ether);
        assertEq(registry.stakedValue(), 0.012 ether);
        assertEq(registry.delay(), 86400);
        assertEq(registry.lastCaller(), address(zd), "registry must see the contract as the staker");
        assertEq(address(zd).balance, 1 ether - 0.012 ether);
    }

    function test_stake_canTopUpWithCallValue() public {
        zd.stake{value: 0.02 ether}(86400, 0.02 ether);
        assertEq(registry.stakedValue(), 0.02 ether);
    }

    function test_stake_revertsWithoutBalanceOrRegistry() public {
        vm.expectRevert(abi.encodeWithSelector(ZeroDrop.InsufficientBalance.selector, 0, 1 ether));
        zd.stake(86400, 1 ether);

        ZeroDrop none = new ZeroDrop(true, address(0));
        vm.expectRevert(ZeroDrop.StakingRegistryNotSet.selector);
        none.stake(86400, 0);
    }

    function test_unlockAndWithdraw_goThroughTheRegistry() public {
        zd.unlockStake();
        assertTrue(registry.unlocked());
        zd.withdrawStake(payable(alice));
        assertEq(registry.withdrewTo(), alice);
        assertEq(registry.lastCaller(), address(zd));
    }

    // ---------------------------------------------------------------- fallback / receive guards

    function test_fallback_rejectsNonEntryCallersWithData() public {
        vm.prank(alice);
        (bool ok, bytes memory ret) = address(zd).call(hex"deadbeef");
        assertFalse(ok);
        assertEq(bytes4(ret), ZeroDrop.NotFrameEntry.selector);
    }

    function test_fallback_acceptsPlainEtherFromOthers() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(zd).call{value: 0.5 ether}("");
        assertTrue(ok);
        assertEq(address(zd).balance, 0.5 ether);
    }

    function test_entryPoint_cannotSendEtherOrDonate() public {
        vm.deal(ENTRY, 1 ether);
        vm.prank(ENTRY);
        (bool ok, bytes memory ret) = address(zd).call{value: 1 ether}("");
        assertFalse(ok);
        assertEq(bytes4(ret), ZeroDrop.EtherRejected.selector);

        vm.prank(ENTRY);
        vm.expectRevert(ZeroDrop.EtherRejected.selector);
        zd.donate{value: 1 ether}();
        assertEq(address(zd).balance, 0);
    }

    function test_donate_worksForOthers() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        zd.donate{value: 1 ether}();
        assertEq(address(zd).balance, 1 ether);
    }

    function test_verifyFrame_withoutFrameOpcodes_revertsAtFirstOpcode() public {
        // Plain EVM: TXPARAM (0xb0) is an invalid opcode, so the helper halts and the call fails closed.
        (bool ok,) = _verify();
        assertFalse(ok);
    }

    // ---------------------------------------------------------------- fallback logic, scripted opcodes

    function test_verifyFrame_happyPath_approvesExecutionAndPayment() public {
        uint256 g = _group();
        _script(zd, g, CID, ROOT, NULLIFIER, proofBytes);

        vm.recordLogs();
        (bool ok,) = _verify();
        assertTrue(ok, "verify frame should pass");

        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].emitter, address(zd));
        assertEq(logs[0].topics[0], Approved.selector);
        assertEq(abi.decode(logs[0].data, (uint256)), uint256(Scope.EXECUTION_AND_PAYMENT));
    }

    function test_verifyFrame_decodesTheProofAndArgumentsFromFrameData() public {
        // The verifier only accepts the exact tuple that the frame data carries.
        uint256 g = _group();
        bytes memory proof = new bytes(256);
        for (uint256 i; i < proof.length; ++i) {
            proof[i] = bytes1(uint8(i));
        }
        _script(zd, g, CID, ROOT, NULLIFIER, proof);
        zd.setVerifier(address(new ExactVerifier(ROOT, NULLIFIER, zd.messageOf(CID, g, CASE), zd.scopeOf(CASE), DEPTH, proof)));
        (bool ok,) = _verify();
        assertTrue(ok);
    }

    function test_verifyFrame_rejectsWrongFrameCount() public {
        uint256 g = _group();
        _script(zd, g, CID, ROOT, NULLIFIER, proofBytes);
        _setTx(zd, TxParam.FRAME_COUNT, 3);
        _expectVerifyRevert(abi.encodeWithSelector(DisclosureFrameChecks.FrameCountMismatch.selector, 3));
    }

    function test_verifyFrame_rejectsNonSenderBodyFrame() public {
        uint256 g = _group();
        _script(zd, g, CID, ROOT, NULLIFIER, proofBytes);
        _setFrame(zd, 1, FrameParam.MODE, uint256(FrameMode.DEFAULT));
        _expectVerifyRevert(abi.encodeWithSelector(ZeroDrop.FrameModeMismatch.selector, 0));
    }

    function test_verifyFrame_rejectsForeignTarget() public {
        uint256 g = _group();
        _script(zd, g, CID, ROOT, NULLIFIER, proofBytes);
        _setFrame(zd, 1, FrameParam.RESOLVED_TARGET, uint256(uint160(alice)));
        _expectVerifyRevert(abi.encodeWithSelector(DisclosureFrameChecks.FrameTargetMismatch.selector, alice, address(zd)));
    }

    function test_verifyFrame_rejectsValue() public {
        uint256 g = _group();
        _script(zd, g, CID, ROOT, NULLIFIER, proofBytes);
        _setFrame(zd, 1, FrameParam.VALUE, 1);
        _expectVerifyRevert(abi.encodeWithSelector(DisclosureFrameChecks.FrameValueNonZero.selector, 1));
    }

    function test_verifyFrame_rejectsOtherSelector() public {
        uint256 g = _group();
        _script(zd, g, CID, ROOT, NULLIFIER, proofBytes);
        bytes memory d = _recordData(g, CASE, CID, ROOT, NULLIFIER, DEPTH, proofBytes);
        d[0] = 0x12;
        d[1] = 0x34;
        d[2] = 0x56;
        d[3] = 0x78;
        _setData(zd, d);
        _expectVerifyRevert(
            abi.encodeWithSelector(
                DisclosureFrameChecks.SelectorMismatch.selector, bytes4(0x12345678), DisclosureFrameChecks.RECORD_SELECTOR
            )
        );
    }

    function test_verifyFrame_rejectsLowBodyGas() public {
        uint256 g = _group();
        _script(zd, g, CID, ROOT, NULLIFIER, proofBytes);
        _setFrame(zd, 1, FrameParam.EXECUTION_GAS_LIMIT, DisclosureFrameChecks.MIN_BODY_GAS - 1);
        _expectVerifyRevert(
            abi.encodeWithSelector(
                DisclosureFrameChecks.BodyGasTooLow.selector,
                DisclosureFrameChecks.MIN_BODY_GAS - 1,
                DisclosureFrameChecks.MIN_BODY_GAS
            )
        );
    }

    function test_verifyFrame_rejectsExpensiveTransaction() public {
        uint256 g = _group();
        _script(zd, g, CID, ROOT, NULLIFIER, proofBytes);
        _setTx(zd, TxParam.MAX_COST, DisclosureFrameChecks.MAX_COST_CAP + 1);
        _expectVerifyRevert(
            abi.encodeWithSelector(
                DisclosureFrameChecks.MaxCostTooHigh.selector,
                DisclosureFrameChecks.MAX_COST_CAP + 1,
                DisclosureFrameChecks.MAX_COST_CAP
            )
        );
    }

    function test_verifyFrame_rejectsUnknownRoot() public {
        uint256 g = _group();
        _script(zd, g, CID, ROOT + 1, NULLIFIER, proofBytes);
        _expectVerifyRevert(abi.encodeWithSelector(DisclosureFrameChecks.RootUnknown.selector));
    }

    function test_verifyFrame_rejectsRootBelowMinSize() public {
        uint256 g = zd.createGroup(5);
        uint256[] memory c = new uint256[](2);
        c[0] = 1;
        c[1] = 2;
        zd.addMembers(g, c, ROOT);
        _script(zd, g, CID, ROOT, NULLIFIER, proofBytes);
        _expectVerifyRevert(abi.encodeWithSelector(ZeroDrop.InsufficientGroupSize.selector));
    }

    function test_verifyFrame_rejectsZeroNullifier() public {
        uint256 g = _group();
        _script(zd, g, CID, ROOT, 0, proofBytes);
        _expectVerifyRevert(abi.encodeWithSelector(DisclosureFrameChecks.NullifierZero.selector));
    }

    function test_verifyFrame_rejectsNonceKeyThatIsNotTheNullifier() public {
        uint256 g = _group();
        _script(zd, g, CID, ROOT, NULLIFIER, proofBytes);
        _setTx(zd, TxParam.NONCE_KEY_0, NULLIFIER + 1);
        _expectVerifyRevert(abi.encodeWithSelector(ZeroDrop.NonceKeyMismatch.selector, NULLIFIER + 1, NULLIFIER));
    }

    function test_verifyFrame_rejectsUsedNullifierAndRecordedCid() public {
        uint256 g = _group();
        _script(zd, g, CID, ROOT, NULLIFIER, proofBytes);
        vm.prank(address(zd));
        zd.record(g, CASE, CID, ROOT, NULLIFIER, DEPTH, proofBytes);

        _expectVerifyRevert(abi.encodeWithSelector(ZeroDrop.AlreadyRecorded.selector));

        _script(zd, g, keccak256("cid-2"), ROOT, NULLIFIER, proofBytes);
        _expectVerifyRevert(abi.encodeWithSelector(ZeroDrop.NullifierAlreadyUsed.selector));
    }

    function test_verifyFrame_rejectsBadProof() public {
        uint256 g = _group();
        zd.setVerifier(address(new RejectingVerifier()));
        _script(zd, g, CID, ROOT, NULLIFIER, proofBytes);
        _expectVerifyRevert(abi.encodeWithSelector(ZeroDrop.InvalidProof.selector));
    }

    function test_verifyFrame_rejectsMalformedFrameData() public {
        uint256 g = _group();
        _script(zd, g, CID, ROOT, NULLIFIER, proofBytes);

        bytes memory d = _recordData(g, CASE, CID, ROOT, NULLIFIER, DEPTH, proofBytes);
        // Cut the proof short while keeping the declared length.
        bytes memory shortData = new bytes(d.length - 64);
        for (uint256 i; i < shortData.length; ++i) {
            shortData[i] = d[i];
        }
        _setData(zd, shortData);
        _expectVerifyRevert(abi.encodeWithSelector(ZeroDrop.MalformedRecordData.selector, "data too short"));

        // Empty proof.
        _setData(zd, _recordData(g, CASE, CID, ROOT, NULLIFIER, DEPTH, ""));
        _expectVerifyRevert(abi.encodeWithSelector(ZeroDrop.MalformedRecordData.selector, "proof length"));
    }

    // ---------------------------------------------------------------- message binding with the real verifier

    /// @dev A Semaphore proof made for CID A must not authorise CID B. Both the body (`record`) and the VERIFY
    ///      frame must reject it, with the real Groth16 verifier.
    struct Fx {
        uint256 g;
        bytes32 caseId;
        bytes32 cidA;
        bytes32 cidB;
        uint256 root;
        uint256 nullifier;
        uint256 depth;
        bytes proof;
    }

    function _loadFixture() internal returns (Fx memory f, SemaphoreVerifierAdapter adapter) {
        string memory json = vm.readFile(FIXTURE);
        f.g = vm.parseJsonUint(json, ".groupId");
        f.caseId = vm.parseJsonBytes32(json, ".caseId");
        f.cidA = vm.parseJsonBytes32(json, ".cidDigest");
        f.cidB = keccak256("a different document");
        f.root = vm.parseJsonUint(json, ".root");
        f.nullifier = vm.parseJsonUint(json, ".nullifier");
        f.depth = vm.parseJsonUint(json, ".depth");
        f.proof = vm.parseJsonBytes(json, ".proof");
        uint256[] memory commitments = vm.parseJsonUintArray(json, ".commitments");

        adapter = new SemaphoreVerifierAdapter(address(new SemaphoreVerifier()));
        zd.setVerifier(address(adapter));
        assertEq(zd.createGroup(uint32(commitments.length)), f.g);
        zd.addMembers(f.g, commitments, f.root);
    }

    function _scriptFixtureFrame(Fx memory f, bytes32 cid) internal {
        _etchFrameMocks(zd);
        _setTx(zd, TxParam.FRAME_COUNT, 2);
        _setTx(zd, TxParam.MAX_COST, 1e15);
        _setTx(zd, TxParam.NONCE_KEY_0, f.nullifier);
        _setFrame(zd, 1, FrameParam.MODE, uint256(FrameMode.SENDER));
        _setFrame(zd, 1, FrameParam.RESOLVED_TARGET, uint256(uint160(address(zd))));
        _setFrame(zd, 1, FrameParam.EXECUTION_GAS_LIMIT, DisclosureFrameChecks.MIN_BODY_GAS);
        _setData(zd, _recordData(f.g, f.caseId, cid, f.root, f.nullifier, f.depth, f.proof));
    }

    /// @dev A Semaphore proof made for CID A must not authorise CID B. The adapter, the VERIFY frame and the body
    ///      frame (`record`) must each reject it, with the real Groth16 verifier.
    function test_realProofForCidA_isRejectedForCidB() public {
        (Fx memory f, SemaphoreVerifierAdapter adapter) = _loadFixture();

        // The adapter itself binds the message.
        assertTrue(
            adapter.verify(f.root, f.nullifier, zd.messageOf(f.cidA, f.g, f.caseId), zd.scopeOf(f.caseId), f.depth, f.proof)
        );
        assertFalse(
            adapter.verify(f.root, f.nullifier, zd.messageOf(f.cidB, f.g, f.caseId), zd.scopeOf(f.caseId), f.depth, f.proof)
        );

        // VERIFY frame: CID B with A's proof fails; CID A passes.
        _scriptFixtureFrame(f, f.cidB);
        _expectVerifyRevert(abi.encodeWithSelector(ZeroDrop.InvalidProof.selector));
        _scriptFixtureFrame(f, f.cidA);
        (bool ok,) = _verify();
        assertTrue(ok, "same proof, the document it was made for");

        // Body frame: same rule on the self-call path.
        vm.prank(address(zd));
        vm.expectRevert(ZeroDrop.InvalidProof.selector);
        zd.record(f.g, f.caseId, f.cidB, f.root, f.nullifier, f.depth, f.proof);
        vm.prank(address(zd));
        zd.record(f.g, f.caseId, f.cidA, f.root, f.nullifier, f.depth, f.proof);
    }
}

/// @dev Accepts only an exact tuple, including the proof bytes.
contract ExactVerifier is IDisclosureVerifier {
    bytes32 internal immutable expected;

    constructor(uint256 root, uint256 nullifier, uint256 message, uint256 scope, uint256 depth, bytes memory proof) {
        expected = keccak256(abi.encode(root, nullifier, message, scope, depth, proof));
    }

    function verify(uint256 root, uint256 nullifier, uint256 message, uint256 scope, uint256 depth, bytes calldata proof)
        external
        view
        returns (bool)
    {
        return keccak256(abi.encode(root, nullifier, message, scope, depth, proof)) == expected;
    }
}

contract RejectingVerifier is IDisclosureVerifier {
    function verify(uint256, uint256, uint256, uint256, uint256, bytes calldata) external pure returns (bool) {
        return false;
    }
}

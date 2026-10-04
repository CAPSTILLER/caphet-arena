// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GameRecords} from "../src/GameRecords.sol";

/// Tiny cheatcode interface so the tests need no library (no forge-std, no submodules).
interface Vm {
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function expectRevert(bytes calldata) external;
    function expectEmit(bool, bool, bool, bool) external;
    function warp(uint256) external;
    function deal(address, uint256) external;
}

contract GameRecordsTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address owner = address(0xA11CE);
    address operator = address(0x0B0B);
    address operator2 = address(0x0B0B2);
    address alice = address(0xA1);
    address bob = address(0xB2);
    address stranger = address(0xBAD);

    GameRecords g;

    bytes32 constant R1 = keccak256("r_000000000001");
    bytes32 constant R2 = keccak256("r_000000000002");
    bytes32 constant R3 = keccak256("r_000000000003");
    bytes32 constant SEED = keccak256("any 32 byte value stands in for a sha256 commit");
    bytes32 constant MOVES = keccak256("0:5:0;0:6:0");

    function setUp() public {
        g = new GameRecords(owner, operator);
    }

    // --- helpers
    function _rec(bytes32 id, address w, uint8 mode, uint8 outcome, uint32 score) internal {
        vm.prank(operator);
        g.recordRound(id, w, mode, outcome, score, 7, SEED, MOVES);
    }

    function _assertEq(uint256 a, uint256 b, string memory why) internal pure {
        require(a == b, why);
    }

    // --- setup
    function test_constructor_setsRoles() public view {
        require(g.owner() == owner, "owner");
        require(g.isOperator(operator), "operator");
        require(!g.isOperator(owner), "owner is not operator");
        require(!g.paused(), "not paused");
    }

    function test_constructor_rejectsZero() public {
        vm.expectRevert(abi.encodeWithSelector(GameRecords.ZeroAddress.selector));
        new GameRecords(address(0), operator);
        vm.expectRevert(abi.encodeWithSelector(GameRecords.ZeroAddress.selector));
        new GameRecords(owner, address(0));
    }

    // --- recording
    function test_record_storesRoundAndCounters() public {
        vm.warp(1_800_000_000);
        _rec(R1, alice, 0, 1, 57);
        GameRecords.RoundRecord memory r = g.getRound(R1);
        require(r.roundId == R1 && r.wallet == alice, "ids");
        require(r.mode == 0 && r.outcome == 1 && r.score == 57 && r.volumeBucket == 7, "fields");
        require(r.seedCommit == SEED && r.movesHash == MOVES, "hashes");
        require(r.recordedAt == 1_800_000_000, "time");
        _assertEq(g.bestScore(alice, 0), 57, "best");
        _assertEq(g.roundsPlayed(alice, 0), 1, "played");
        _assertEq(g.totalRounds(), 1, "total");
        require(g.isRecorded(R1) && !g.isRecorded(R2), "isRecorded");
    }

    function test_record_emitsEvents() public {
        vm.expectEmit(true, true, false, true);
        emit GameRecords.NewBestScore(alice, 0, 40, 0);
        vm.expectEmit(true, true, true, true);
        emit GameRecords.RoundRecorded(R1, alice, 0, 1, 40, 7, SEED, MOVES);
        _rec(R1, alice, 0, 1, 40);
    }

    function test_bestScore_onlyRises_andIsPerMode() public {
        _rec(R1, alice, 0, 1, 50);
        _rec(R2, alice, 0, 1, 30); // lower: best stays 50, but the round still counts
        _assertEq(g.bestScore(alice, 0), 50, "best stays");
        _assertEq(g.roundsPlayed(alice, 0), 2, "two rounds");
        _rec(R3, alice, 1, 2, 9);
        _assertEq(g.bestScore(alice, 1), 9, "twin best");
        _assertEq(g.bestScore(alice, 2), 0, "triple untouched");
        _assertEq(g.bestScoreOverall(alice), 50, "overall");
        _assertEq(g.roundsPlayedOverall(alice), 3, "overall rounds");
        _assertEq(g.bestScore(bob, 0), 0, "bob untouched");
    }

    function test_fall_countsAsRoundWithZeroScore() public {
        _rec(R1, alice, 0, 0, 0);
        _assertEq(g.roundsPlayed(alice, 0), 1, "played");
        _assertEq(g.bestScore(alice, 0), 0, "no best");
    }

    function test_scoreIsStoredInFull_noCapOnChain() public {
        _rec(R1, alice, 0, 1, 250_000); // above the 10,000 payout cap: the record keeps the full number
        _assertEq(g.bestScore(alice, 0), 250_000, "full score");
    }

    function test_record_rejectsDuplicateRound() public {
        _rec(R1, alice, 0, 1, 5);
        vm.expectRevert(abi.encodeWithSelector(GameRecords.RoundAlreadyRecorded.selector, R1));
        _rec(R1, bob, 1, 1, 9);
    }

    function test_record_rejectsBadInputs() public {
        vm.expectRevert(abi.encodeWithSelector(GameRecords.BadMode.selector));
        _rec(R1, alice, 3, 1, 5);
        vm.expectRevert(abi.encodeWithSelector(GameRecords.BadOutcome.selector));
        _rec(R1, alice, 0, 3, 5);
        vm.expectRevert(abi.encodeWithSelector(GameRecords.ZeroAddress.selector));
        _rec(R1, address(0), 0, 1, 5);
        vm.expectRevert(abi.encodeWithSelector(GameRecords.EmptyRoundId.selector));
        _rec(bytes32(0), alice, 0, 1, 5);
        vm.expectRevert(abi.encodeWithSelector(GameRecords.BadVolumeBucket.selector));
        vm.prank(operator);
        g.recordRound(R1, alice, 0, 1, 5, 11, SEED, MOVES);
    }

    // --- access control
    function test_onlyOperatorCanRecord() public {
        vm.expectRevert(abi.encodeWithSelector(GameRecords.NotOperator.selector));
        vm.prank(stranger);
        g.recordRound(R1, alice, 0, 1, 5, 1, SEED, MOVES);
        vm.expectRevert(abi.encodeWithSelector(GameRecords.NotOperator.selector));
        vm.prank(owner); // owner administers but cannot write results
        g.recordRound(R1, alice, 0, 1, 5, 1, SEED, MOVES);
    }

    function test_owner_managesOperators() public {
        vm.expectRevert(abi.encodeWithSelector(GameRecords.NotOwner.selector));
        vm.prank(operator);
        g.setOperator(operator2, true);

        vm.expectEmit(true, false, false, true);
        emit GameRecords.OperatorSet(operator2, true);
        vm.prank(owner);
        g.setOperator(operator2, true);
        vm.prank(operator2);
        g.recordRound(R1, alice, 0, 1, 5, 1, SEED, MOVES);

        vm.prank(owner);
        g.setOperator(operator, false); // rotate the old key out
        vm.expectRevert(abi.encodeWithSelector(GameRecords.NotOperator.selector));
        _rec(R2, alice, 0, 1, 5);

        vm.expectRevert(abi.encodeWithSelector(GameRecords.ZeroAddress.selector));
        vm.prank(owner);
        g.setOperator(address(0), true);
    }

    // --- pause
    function test_pause_blocksRecording_unpauseRestores() public {
        vm.expectRevert(abi.encodeWithSelector(GameRecords.NotOwner.selector));
        vm.prank(stranger);
        g.pause();

        vm.expectEmit(true, false, false, false);
        emit GameRecords.Paused(owner);
        vm.prank(owner);
        g.pause();
        require(g.paused(), "paused");
        vm.expectRevert(abi.encodeWithSelector(GameRecords.PausedError.selector));
        _rec(R1, alice, 0, 1, 5);
        // reads still work while paused
        _assertEq(g.bestScore(alice, 0), 0, "read ok");

        vm.expectRevert(abi.encodeWithSelector(GameRecords.NotOwner.selector));
        vm.prank(operator);
        g.unpause();
        vm.prank(owner);
        g.unpause();
        _rec(R1, alice, 0, 1, 5);
        _assertEq(g.totalRounds(), 1, "recorded after unpause");
    }

    // --- ownership
    function test_ownership_twoStep() public {
        vm.expectRevert(abi.encodeWithSelector(GameRecords.NotOwner.selector));
        vm.prank(stranger);
        g.transferOwnership(stranger);

        vm.prank(owner);
        g.transferOwnership(bob);
        require(g.owner() == owner && g.pendingOwner() == bob, "pending");

        vm.expectRevert(abi.encodeWithSelector(GameRecords.NotPendingOwner.selector));
        vm.prank(stranger);
        g.acceptOwnership();

        vm.prank(bob);
        g.acceptOwnership();
        require(g.owner() == bob && g.pendingOwner() == address(0), "handed over");

        vm.expectRevert(abi.encodeWithSelector(GameRecords.NotOwner.selector));
        vm.prank(owner);
        g.pause();
    }

    // --- holds nothing
    function test_rejectsEther() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(g).call{value: 1 wei}("");
        require(!ok, "plain send must fail");
        (bool ok2,) = address(g).call{value: 1 wei}(abi.encodeWithSignature("recordRound()"));
        require(!ok2, "payable call must fail");
        _assertEq(address(g).balance, 0, "balance stays zero");
    }

    // --- fuzz
    function testFuzz_recordKeepsMaxAndCounts(uint32 a, uint32 b, uint8 mode) public {
        mode = uint8(bound(mode, 0, 2));
        _rec(R1, alice, mode, 1, a);
        _rec(R2, alice, mode, 1, b);
        _assertEq(g.bestScore(alice, mode), a > b ? a : b, "max");
        _assertEq(g.roundsPlayed(alice, mode), 2, "count");
    }

    function testFuzz_rejectsBadModeAndOutcome(uint8 mode, uint8 outcome) public {
        bool bad = mode > 2 || outcome > 2;
        vm.prank(operator);
        try g.recordRound(R1, alice, mode, outcome, 1, 1, SEED, MOVES) {
            require(!bad, "should have reverted");
        } catch {
            require(bad, "should not have reverted");
        }
    }

    function bound(uint256 x, uint256 lo, uint256 hi) internal pure returns (uint256) {
        return lo + (x % (hi - lo + 1));
    }
}

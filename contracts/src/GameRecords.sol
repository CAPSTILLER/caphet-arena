// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title GameRecords
/// @notice Public, append-only record book for the CAPHET Arena coin stacking game.
/// @dev Holds NO tokens and NO ETH and pays NOTHING. It only stores results written by an operator
///      signer (the game server). Anyone can read. Anyone can later check a round: the server
///      publishes the seed after the round ends, and `seedCommit` must equal sha256("<roundId>:<seed>"),
///      while `movesHash` commits to the exact move list (see README_FOR_BANKR.md for the format).
///
///      Roles
///        owner     : sets operators, pauses, hands over ownership (two steps). Cannot write records.
///        operator  : writes records. Several operators can be active at once so keys can be rotated.
///
///      Modes: 0 = single, 1 = twin, 2 = triple.
///      Outcomes: 0 = fell, 1 = cashed out, 2 = stacks connected (twin/triple win).
///      volumeBucket: round(quality * 10), 0 to 10, where quality is the 0..1 log scale of the locked
///      24h CAPH volume ($500 gives 0, $100,000 gives 1).
contract GameRecords {
    // ---------------------------------------------------------------------
    // types
    // ---------------------------------------------------------------------

    struct RoundRecord {
        bytes32 roundId;      // keccak256 of the round id string, e.g. keccak256("r_57c9d015fb2f")
        address wallet;
        uint8 mode;           // 0 single, 1 twin, 2 triple
        uint8 outcome;        // 0 fell, 1 cashed out, 2 connected
        uint32 score;         // score recorded for this round (0 if none), stored in full
        uint16 volumeBucket;  // 0..10
        uint64 recordedAt;    // block timestamp
        bytes32 seedCommit;   // sha256("<roundId>:<seed>")
        bytes32 movesHash;    // keccak256 of the canonical move list string
    }

    // ---------------------------------------------------------------------
    // errors and events
    // ---------------------------------------------------------------------

    error NotOwner();
    error NotPendingOwner();
    error NotOperator();
    error PausedError();
    error ZeroAddress();
    error BadMode();
    error BadOutcome();
    error BadVolumeBucket();
    error RoundAlreadyRecorded(bytes32 roundId);
    error EmptyRoundId();

    event RoundRecorded(
        bytes32 indexed roundId,
        address indexed wallet,
        uint8 indexed mode,
        uint8 outcome,
        uint32 score,
        uint16 volumeBucket,
        bytes32 seedCommit,
        bytes32 movesHash
    );
    event NewBestScore(address indexed wallet, uint8 indexed mode, uint32 score, uint32 previousBest);
    event OperatorSet(address indexed operator, bool allowed);
    event OwnershipTransferStarted(address indexed owner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    // ---------------------------------------------------------------------
    // storage
    // ---------------------------------------------------------------------

    uint8 public constant MODE_COUNT = 3;
    uint8 public constant MAX_OUTCOME = 2;
    uint16 public constant MAX_VOLUME_BUCKET = 10;

    address public owner;
    address public pendingOwner;
    bool public paused;
    uint256 public totalRounds;

    mapping(address => bool) public isOperator;
    mapping(address => mapping(uint8 => uint32)) private _bestScore;
    mapping(address => mapping(uint8 => uint32)) private _roundsPlayed;
    mapping(bytes32 => RoundRecord) private _rounds;

    // ---------------------------------------------------------------------
    // setup and admin
    // ---------------------------------------------------------------------

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOperator() {
        if (!isOperator[msg.sender]) revert NotOperator();
        _;
    }

    /// @param initialOwner    Admin address (should be a multisig or Cap's safe wallet).
    /// @param initialOperator Hot key the game server signs with. Can be changed any time by the owner.
    constructor(address initialOwner, address initialOperator) {
        if (initialOwner == address(0) || initialOperator == address(0)) revert ZeroAddress();
        owner = initialOwner;
        isOperator[initialOperator] = true;
        emit OwnershipTransferred(address(0), initialOwner);
        emit OperatorSet(initialOperator, true);
    }

    function setOperator(address operator, bool allowed) external onlyOwner {
        if (operator == address(0)) revert ZeroAddress();
        isOperator[operator] = allowed;
        emit OperatorSet(operator, allowed);
    }

    function pause() external onlyOwner {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    /// @notice Step 1 of a safe ownership handover. The new owner must call acceptOwnership.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        address old = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(old, msg.sender);
    }

    // ---------------------------------------------------------------------
    // writing records (operator only)
    // ---------------------------------------------------------------------

    /// @notice Record one finished round. Each roundId can be written once.
    function recordRound(
        bytes32 roundId,
        address wallet,
        uint8 mode,
        uint8 outcome,
        uint32 score,
        uint16 volumeBucket,
        bytes32 seedCommit,
        bytes32 movesHash
    ) external onlyOperator {
        if (paused) revert PausedError();
        if (roundId == bytes32(0)) revert EmptyRoundId();
        if (wallet == address(0)) revert ZeroAddress();
        if (mode >= MODE_COUNT) revert BadMode();
        if (outcome > MAX_OUTCOME) revert BadOutcome();
        if (volumeBucket > MAX_VOLUME_BUCKET) revert BadVolumeBucket();
        if (_rounds[roundId].roundId != bytes32(0)) revert RoundAlreadyRecorded(roundId);

        _rounds[roundId] = RoundRecord({
            roundId: roundId,
            wallet: wallet,
            mode: mode,
            outcome: outcome,
            score: score,
            volumeBucket: volumeBucket,
            recordedAt: uint64(block.timestamp),
            seedCommit: seedCommit,
            movesHash: movesHash
        });
        unchecked {
            totalRounds += 1;
            _roundsPlayed[wallet][mode] += 1;
        }

        uint32 prev = _bestScore[wallet][mode];
        if (score > prev) {
            _bestScore[wallet][mode] = score;
            emit NewBestScore(wallet, mode, score, prev);
        }
        emit RoundRecorded(roundId, wallet, mode, outcome, score, volumeBucket, seedCommit, movesHash);
    }

    // ---------------------------------------------------------------------
    // reading
    // ---------------------------------------------------------------------

    function bestScore(address wallet, uint8 mode) external view returns (uint32) {
        return _bestScore[wallet][mode];
    }

    function roundsPlayed(address wallet, uint8 mode) external view returns (uint32) {
        return _roundsPlayed[wallet][mode];
    }

    /// @notice Highest best score over all modes (this is the number the ante is based on).
    function bestScoreOverall(address wallet) external view returns (uint32 best) {
        for (uint8 m = 0; m < MODE_COUNT; m++) {
            uint32 s = _bestScore[wallet][m];
            if (s > best) best = s;
        }
    }

    function roundsPlayedOverall(address wallet) external view returns (uint32 total) {
        for (uint8 m = 0; m < MODE_COUNT; m++) total += _roundsPlayed[wallet][m];
    }

    function getRound(bytes32 roundId) external view returns (RoundRecord memory) {
        return _rounds[roundId];
    }

    function isRecorded(bytes32 roundId) external view returns (bool) {
        return _rounds[roundId].roundId != bytes32(0);
    }
}

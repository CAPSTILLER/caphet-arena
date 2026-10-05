// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CaphetBotNFT} from "./CaphetBotNFT.sol";

/// @title CaphetBotDailyClaim
/// @notice STUB ONLY. Not live CAPH. Documents the intended daily claim flow for CaphetBotNFT.
///
///         Intended flow (later phase; Cap funds a CAPH vault):
///           1. Caller proves they own tokenId (ownerOf on CaphetBotNFT).
///           2. Server (or merkle/oracle) attests the bot is eligible for today's UTC day and
///              that it has not already claimed. The "play" is this attested claim, not a
///              downloadable agent strategy and not a stealable real-bot session.
///           3. Payout amount is EXACTLY CaphetBotNFT.dailyPayoutOf(tokenId) (10/20/50/100 CAPH
///              by rarity). No score-based boost for NFT bots. HARD CAP.
///           4. Vault limits: at most 500,000 CAPH paid out per day across all claims, and at
///              most 10,000 CAPH per single payout call (safety valve; rarity max is 100).
///           5. Higher game scores may still be recorded offchain / on GameRecords for glory,
///              but they do not raise the NFT daily CAPH amount.
///
///         This stub reverts on claim so nobody can drain anything. Deploy only when Cap is
///         ready to wire real CAPH and an attestation path.

contract CaphetBotDailyClaim {
    error NotLive();
    error NotOwner();
    error ZeroAddress();

    CaphetBotNFT public immutable bots;
    address public owner;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    constructor(address bots_, address initialOwner) {
        if (bots_ == address(0) || initialOwner == address(0)) revert ZeroAddress();
        bots = CaphetBotNFT(bots_);
        owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    /// @notice Always reverts. Placeholder for the later attested claim.
    /// @param tokenId Bot NFT id the caller must own when this goes live.
    /// @param dayId UTC day key the attestation covers (e.g. days since unix epoch).
    /// @param attestation Server signature or merkle proof bytes (format TBD).
    function claim(uint256 tokenId, uint256 dayId, bytes calldata attestation) external pure {
        tokenId;
        dayId;
        attestation;
        revert NotLive();
    }

    /// @notice Reads the hard-capped daily amount from the NFT (for UIs and later wiring).
    function quote(uint256 tokenId) external view returns (uint256) {
        return bots.dailyPayoutOf(tokenId);
    }

    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert NotOwner();
        if (newOwner == address(0)) revert ZeroAddress();
        address prev = owner;
        owner = newOwner;
        emit OwnershipTransferred(prev, newOwner);
    }
}

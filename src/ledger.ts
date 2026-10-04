import { MAX_PAYOUT_TOKENS } from './constants.js';
import { fallFee } from './fees.js';
import { createRound, EngineError } from './engine.js';
import type { Seed } from './prng.js';
import type { Mode, RoundState } from './types.js';

/**
 * Token ledger model. Pure functions, whole tokens only. No chain calls here.
 *
 * Money flow for one round:
 *   1. At the start the wallet pays the ante (its best registered score, capped at 10,000) into the vault: walletToVault = stake
 *   2. When the round ends the vault pays the wallet:                                     vaultToWallet = payout
 *   3. If the stack fell AND the wallet's best score is above 0, the vault pays the
 *      5% fall fee to the treasury:                                                       vaultToTreasury = fee
 * Every payout to the wallet is capped at MAX_PAYOUT_TOKENS (10,000). Scores are always recorded in full.
 *
 * Outcomes:
 *   fell                         payout 0 (the ante stays in the vault). Fee only if best score > 0.
 *   cashed, single stack         payout = the CURRENT round score exactly (the ante is NOT refunded on top).
 *                                Below the ante that is a net loss. Score recorded; best score rises if beaten.
 *   touched (twin/triple)        payout = the ante back, nothing more. The capped round score is recorded.
 *   cashed, twin/triple          payout = the ante back. No score recorded.
 *   maxed (120 coin safety cap)  treated like a cash out for that mode.
 */

export type Outcome = 'fell' | 'cashed_scored' | 'cashed_unscored' | 'touched' | 'maxed_scored' | 'maxed_unscored';

export interface LedgerEntry {
  mode: Mode;
  outcome: Outcome;
  /** Tokens the wallet paid in at the start (the ante). */
  stake: number;
  /** Round score that counts (capped for twin/triple). 0 for falls and unscored cash outs. */
  score: number;
  /** Score before the twin/triple cap. Same as score in every other case. */
  rawScore: number;
  /** Tokens the wallet receives at the end, after the per-payout cap. */
  payout: number;
  /** True when the 10,000 cap reduced the payout. */
  payoutCapped: boolean;
  /** Score to register for the wallet (full, never capped by the payout cap), or null when this round records no score. */
  recordedScore: number | null;
  /** The wallet's best registered score after this round (only ever goes up). */
  newHighScore: number;
  walletToVault: number;
  vaultToWallet: number;
  /** Fall fee from the vault to the treasury. 0 unless the stack fell and the wallet's best score was above 0. */
  vaultToTreasury: number;
  coinsOnTable: number;
  /** Wallet net result in tokens (payout minus stake). */
  walletNet: number;
  /** What the vault keeps from this round: stake minus payout minus fee. Negative means the vault lost tokens. */
  vaultNet: number;
}

/** A wallet with no registered high score (first play) may only play single stack. */
export function canPlayMode(walletHighScore: number, mode: Mode): boolean {
  if (!Number.isInteger(walletHighScore) || walletHighScore < 0) throw new EngineError('walletHighScore must be a whole number >= 0');
  return mode === 'single' || walletHighScore > 0;
}

/**
 * The ante for the next play: the wallet's best registered score in tokens, capped at 10,000
 * (0 on a first play). The best score itself is still stored in full.
 */
export function anteFor(walletHighScore: number): number {
  if (!Number.isInteger(walletHighScore) || walletHighScore < 0) throw new EngineError('walletHighScore must be a whole number >= 0');
  return Math.min(walletHighScore, MAX_PAYOUT_TOKENS);
}

/** createRound, but refuses a mode the wallet may not play yet. */
export function startRoundForWallet(walletHighScore: number, mode: Mode, seed: Seed, volumeUsd: number): RoundState {
  if (!canPlayMode(walletHighScore, mode)) throw new EngineError(`a wallet with no registered high score can only play single stack (asked for ${mode})`);
  return createRound(mode, seed, volumeUsd);
}

/**
 * Work out every token movement for a finished round. Throws if the round is still active.
 * `stake` defaults to anteFor(wallet.highScore) (the best registered score, capped at 10,000).
 */
export function settleRound(state: RoundState, wallet: { highScore: number; stake?: number }): LedgerEntry {
  if (state.status === 'active') throw new EngineError('round is still active');
  const stake = wallet.stake ?? anteFor(wallet.highScore);
  if (!Number.isInteger(stake) || stake < 0) throw new EngineError('stake must be a whole number >= 0');
  if (!canPlayMode(wallet.highScore, state.mode)) throw new EngineError('wallet may not play this mode');

  const finish = (o: {
    outcome: Outcome;
    score: number;
    rawScore: number;
    recordedScore: number | null;
    uncappedPayout: number;
    fee: number;
  }): LedgerEntry => {
    const payout = Math.min(o.uncappedPayout, MAX_PAYOUT_TOKENS);
    return {
      mode: state.mode,
      outcome: o.outcome,
      stake,
      score: o.score,
      rawScore: o.rawScore,
      payout,
      payoutCapped: payout < o.uncappedPayout,
      recordedScore: o.recordedScore,
      newHighScore: o.recordedScore === null ? wallet.highScore : Math.max(wallet.highScore, o.recordedScore),
      walletToVault: stake,
      vaultToWallet: payout,
      vaultToTreasury: o.fee,
      coinsOnTable: state.coinsOnTable,
      walletNet: payout - stake,
      vaultNet: stake - payout - o.fee,
    };
  };

  if (state.status === 'fell') {
    // The ante stays in the vault. Only a wallet with a registered best score above 0 triggers the fee.
    const fee = wallet.highScore > 0 ? fallFee(state.coinsOnTable) : 0;
    return finish({ outcome: 'fell', score: 0, rawScore: 0, recordedScore: null, uncappedPayout: 0, fee });
  }

  if (state.mode === 'single') {
    // Cash out (or safety cap): the wallet receives exactly the current score. The ante is not refunded on top.
    return finish({
      outcome: state.status === 'maxed' ? 'maxed_scored' : 'cashed_scored',
      score: state.score,
      rawScore: state.rawScore,
      recordedScore: state.score,
      uncappedPayout: state.score,
      fee: 0,
    });
  }

  if (state.status === 'touched') {
    // Winning twin/triple round: only the ante comes back; the capped score is recorded.
    return finish({ outcome: 'touched', score: state.score, rawScore: state.rawScore, recordedScore: state.score, uncappedPayout: stake, fee: 0 });
  }

  // Twin/triple cash out (or safety cap) before connecting: ante back, no score recorded.
  return finish({
    outcome: state.status === 'maxed' ? 'maxed_unscored' : 'cashed_unscored',
    score: 0,
    rawScore: 0,
    recordedScore: null,
    uncappedPayout: stake,
    fee: 0,
  });
}

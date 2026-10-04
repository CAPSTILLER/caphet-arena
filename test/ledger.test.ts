import { describe, expect, it } from 'vitest';
import {
  EngineError,
  anteFor,
  canPlayMode,
  cashOut,
  createRound,
  offsetToward,
  placeCoin,
  settleRound,
  startRoundForWallet,
  type RoundState,
} from '../src/index.js';

const PERFECT = 100_000;
const fell = (mode: 'single' | 'twin' | 'triple' = 'single'): RoundState => placeCoin(createRound(mode, 'f', PERFECT), 50, 0);
const single20 = (): RoundState => cashOut(placeCoin(createRound('single', 's', PERFECT), 20.4));

describe('mode gating (first play is single stack only)', () => {
  it('canPlayMode', () => {
    expect(canPlayMode(0, 'single')).toBe(true);
    expect(canPlayMode(0, 'twin')).toBe(false);
    expect(canPlayMode(0, 'triple')).toBe(false);
    expect(canPlayMode(1, 'twin')).toBe(true);
    expect(canPlayMode(250, 'triple')).toBe(true);
    expect(canPlayMode(250, 'single')).toBe(true);
    expect(() => canPlayMode(-1, 'single')).toThrow(EngineError);
    expect(() => canPlayMode(1.5, 'single')).toThrow(EngineError);
  });
  it('startRoundForWallet refuses a locked mode', () => {
    expect(() => startRoundForWallet(0, 'twin', 1, PERFECT)).toThrow(EngineError);
    expect(startRoundForWallet(0, 'single', 1, PERFECT).mode).toBe('single');
    expect(startRoundForWallet(5, 'triple', 1, PERFECT).mode).toBe('triple');
  });
  it('the ante is the wallet high score', () => {
    expect(anteFor(0)).toBe(0);
    expect(anteFor(42)).toBe(42);
  });
  it('the ante is capped at 10,000 but the best score is stored in full', () => {
    expect(anteFor(10_000)).toBe(10_000);
    expect(anteFor(15_000)).toBe(10_000);
    const s = cashOut(createRound('twin', 'big', PERFECT));
    const e = settleRound(s, { highScore: 15_000 });
    expect(e).toMatchObject({ stake: 10_000, walletToVault: 10_000, newHighScore: 15_000 });
  });
  it('mode gate still uses the full best score', () => {
    expect(canPlayMode(15_000, 'triple')).toBe(true);
  });
});

describe('fall settlement', () => {
  it('a wallet with high score 0 moves no tokens and pays no fee', () => {
    const e = settleRound(fell(), { highScore: 0 });
    expect(e.outcome).toBe('fell');
    expect(e).toMatchObject({ stake: 0, payout: 0, walletToVault: 0, vaultToWallet: 0, vaultToTreasury: 0, walletNet: 0, recordedScore: null, newHighScore: 0 });
  });
  it('a wallet with a registered high score loses its stake and the vault pays the fee to the treasury', () => {
    const e = settleRound(fell(), { highScore: 30 });
    expect(e).toMatchObject({ stake: 30, payout: 0, walletToVault: 30, vaultToWallet: 0, walletNet: -30, newHighScore: 30, recordedScore: null });
    expect(e.coinsOnTable).toBe(2); // base coin + the coin that fell
    expect(e.vaultToTreasury).toBe(1);
  });
  it('fee = ceil(5%) of every coin on the table in play, all stacks, including the coin that fell', () => {
    const s = fell('triple'); // 3 base coins + the fallen one
    expect(s.coinsOnTable).toBe(4);
    expect(settleRound(s, { highScore: 10 }).vaultToTreasury).toBe(1);
    expect(settleRound({ ...s, coinsOnTable: 100 }, { highScore: 10 }).vaultToTreasury).toBe(5);
    expect(settleRound({ ...s, coinsOnTable: 101 }, { highScore: 10 }).vaultToTreasury).toBe(6);
    expect(settleRound({ ...fell(), coinsOnTable: 101 }, { highScore: 0 }).vaultToTreasury).toBe(0);
  });
  it('a twin fall with a high score also charges the fee on both stacks worth of coins', () => {
    let s = createRound('twin', 'tf', PERFECT);
    for (let i = 0; i < 12; i++) s = placeCoin(s, 0, 0);
    s = placeCoin(s, 50, 1);
    expect(s.status).toBe('fell');
    expect(s.coinsOnTable).toBe(2 + 12 + 1);
    expect(settleRound(s, { highScore: 8 }).vaultToTreasury).toBe(1);
  });
});

describe('single stack cash out: wallet receives exactly the current score', () => {
  it('first-play wallet (ante 0) gets the score as payout and a new best score', () => {
    const e = settleRound(single20(), { highScore: 0 });
    expect(e).toMatchObject({ outcome: 'cashed_scored', stake: 0, score: 20, rawScore: 20, payout: 20, recordedScore: 20, newHighScore: 20, vaultToTreasury: 0, walletNet: 20, vaultNet: -20 });
  });
  it('the ante is not refunded on top: score above the ante is a net win of score - ante', () => {
    const e = settleRound(single20(), { highScore: 15 });
    expect(e).toMatchObject({ stake: 15, payout: 20, walletToVault: 15, vaultToWallet: 20, walletNet: 5, recordedScore: 20, newHighScore: 20, vaultNet: -5 });
  });
  it('score equal to the ante breaks even', () => {
    const e = settleRound(single20(), { highScore: 20 });
    expect(e).toMatchObject({ stake: 20, payout: 20, walletNet: 0, newHighScore: 20 });
  });
  it('score below the ante only gets the lower amount back (net loss) and the best score stays', () => {
    const e = settleRound(single20(), { highScore: 50 });
    expect(e).toMatchObject({ stake: 50, payout: 20, walletToVault: 50, vaultToWallet: 20, walletNet: -30, vaultNet: 30, recordedScore: 20, newHighScore: 50, vaultToTreasury: 0 });
  });
  it('cash out at score 0 returns nothing', () => {
    const e = settleRound(cashOut(createRound('single', 'z', PERFECT)), { highScore: 9 });
    expect(e).toMatchObject({ stake: 9, payout: 0, score: 0, walletNet: -9, recordedScore: 0, newHighScore: 9 });
  });
});

describe('twin and triple settlement: only the ante comes back', () => {
  const win = (mode: 'twin' | 'triple'): RoundState => {
    let s = createRound(mode, 'w', PERFECT);
    const lean = [10.5, 15.8, 31.7];
    if (mode === 'twin') {
      for (const o of lean) s = placeCoin(s, o, 0);
      for (const o of lean) s = placeCoin(s, -o, 1);
    } else {
      const { cx, cy } = { cx: s.tableCenter.x, cy: s.tableCenter.y };
      for (let layer = 0; layer < 3; layer++) {
        for (let st = 0; st < 3; st++) {
          const top = s.stacks[st]![s.stacks[st]!.length - 1]!;
          s = placeCoin(s, offsetToward(top.x, top.y, cx, cy, lean[layer]!), st);
        }
      }
    }
    return s;
  };
  it('a winning round returns exactly the ante, with no extra winnings, and records the score', () => {
    for (const mode of ['twin', 'triple'] as const) {
      const s = win(mode);
      expect(s.status).toBe('touched');
      const e = settleRound(s, { highScore: 3 });
      expect(e).toMatchObject({ outcome: 'touched', stake: 3, score: 4, rawScore: 4, payout: 3, walletNet: 0, recordedScore: 4, newHighScore: 4, vaultToTreasury: 0, vaultNet: 0 });
    }
  });
  it('a win records a score even though it pays nothing extra: best score rises', () => {
    expect(settleRound(win('twin'), { highScore: 2 }).newHighScore).toBe(4);
    expect(settleRound(win('twin'), { highScore: 9 }).newHighScore).toBe(9);
  });
  it('cash out before connecting returns the ante and records no score', () => {
    for (const mode of ['twin', 'triple'] as const) {
      const s = cashOut(placeCoin(createRound(mode, 'c', PERFECT), 5, 0));
      const e = settleRound(s, { highScore: 25 });
      expect(e).toMatchObject({ outcome: 'cashed_unscored', stake: 25, payout: 25, walletNet: 0, score: 0, recordedScore: null, newHighScore: 25, vaultToTreasury: 0, vaultNet: 0 });
    }
  });
  it('a twin/triple round score is reported raw and capped', () => {
    const s0 = createRound('twin', 'cap', PERFECT);
    const coin = (x: number, y = 0) => ({ x, y, comX: 0, comY: 0, supportScale: 1 });
    const tall = [coin(0), coin(0), coin(58.1), ...Array.from({ length: 27 }, () => coin(0))]; // 30 coins
    let s: RoundState = { ...s0, stacks: [tall, s0.stacks[1]!], coinsOnTable: 31 };
    s = placeCoin(s, -8.7, 1);
    s = placeCoin(s, -28.5, 1); // B layer 2 touches A layer 2
    expect(s.status).toBe('touched');
    expect(s.rawScore).toBe(30);
    expect(s.score).toBe(13); // second tallest (3) + 10
    const e = settleRound(s, { highScore: 4 });
    expect(e).toMatchObject({ rawScore: 30, score: 13, recordedScore: 13, newHighScore: 13 });
  });
});

describe('10,000 payout cap', () => {
  it('caps the payout to the wallet but records the full score', () => {
    const s = { ...single20(), score: 12_345, rawScore: 12_345 };
    const e = settleRound(s, { highScore: 100 });
    expect(e).toMatchObject({ payout: 10_000, payoutCapped: true, recordedScore: 12_345, newHighScore: 12_345, walletToVault: 100, walletNet: 9_900 });
  });
  it('a huge best score costs at most 10,000 to ante, so twin/triple refunds are never cut by the cap', () => {
    const s = cashOut(createRound('twin', 'cc', PERFECT));
    const e = settleRound(s, { highScore: 15_000 });
    expect(e).toMatchObject({ stake: 10_000, payout: 10_000, payoutCapped: false, walletNet: 0, newHighScore: 15_000 });
  });
  it('a single stack payout above 10,000 is capped for the wallet, ante is 10,000, best score recorded in full', () => {
    const s = { ...single20(), score: 14_000, rawScore: 14_000 };
    const e = settleRound(s, { highScore: 15_000 });
    expect(e).toMatchObject({ stake: 10_000, payout: 10_000, payoutCapped: true, walletNet: 0, recordedScore: 14_000, newHighScore: 15_000 });
  });
  it('does not flag small payouts', () => {
    expect(settleRound(single20(), { highScore: 0 }).payoutCapped).toBe(false);
  });
});

describe('ledger identities', () => {
  it('walletNet = vaultToWallet - walletToVault and vaultNet = stake - payout - fee', () => {
    for (const s of [fell(), single20(), cashOut(createRound('twin', 'b', PERFECT))]) {
      const e = settleRound(s, { highScore: 17 });
      expect(e.walletNet).toBe(e.vaultToWallet - e.walletToVault);
      expect(e.payout).toBe(e.vaultToWallet);
      expect(e.vaultNet).toBe(e.walletToVault - e.vaultToWallet - e.vaultToTreasury);
    }
  });
  it('rejects unfinished rounds and wallets that may not play the mode', () => {
    expect(() => settleRound(createRound('single', 1, PERFECT), { highScore: 0 })).toThrow(EngineError);
    expect(() => settleRound(cashOut(createRound('twin', 1, PERFECT)), { highScore: 0 })).toThrow(EngineError);
  });
});

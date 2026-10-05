import { describe, expect, it } from 'vitest';
import {
  NFT_MAX_SUPPLY, NFT_MINT_GEAR, NFT_SECURITY, NFT_TREASURY_BPS, NFT_VAULT_BPS,
  RARITY_DAILY_CAPH, RARITY_WEIGHTS, VAULT_DAY_LIMIT_CAPH, VAULT_PER_PAYOUT_LIMIT_CAPH,
  dailyPayoutCaph, rarityFromRoll,
} from '../src/nft/rules.js';

describe('CaphetBot NFT rules', () => {
  it('locks supply, price split, rarity odds and hard daily caps', () => {
    expect(NFT_MAX_SUPPLY).toBe(1000);
    expect(NFT_MINT_GEAR).toBe(100);
    expect(NFT_TREASURY_BPS + NFT_VAULT_BPS).toBe(10_000);
    expect(NFT_TREASURY_BPS).toBe(9000);
    expect(Object.values(RARITY_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    expect(RARITY_DAILY_CAPH).toEqual({ 0: 10, 1: 20, 2: 50, 3: 100 });
    expect(VAULT_DAY_LIMIT_CAPH).toBe(500_000);
    expect(VAULT_PER_PAYOUT_LIMIT_CAPH).toBe(10_000);
    for (const r of [0, 1, 2, 3] as const) {
      expect(dailyPayoutCaph(r)).toBe(RARITY_DAILY_CAPH[r]);
      expect(dailyPayoutCaph(r)).toBeLessThanOrEqual(VAULT_PER_PAYOUT_LIMIT_CAPH);
    }
  });

  it('rarityFromRoll matches 50/30/15/5', () => {
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 100; i++) counts[rarityFromRoll(i)]!++;
    expect(counts).toEqual([50, 30, 15, 5]);
  });

  it('NFT bots cannot be used as stealable real agent bots', () => {
    expect(NFT_SECURITY.grantsAgentApi).toBe(false);
    expect(NFT_SECURITY.grantsPrivateKey).toBe(false);
    expect(NFT_SECURITY.downloadableStrategy).toBe(false);
    expect(NFT_SECURITY.scoreBoostsPayout).toBe(false);
    expect(NFT_SECURITY.playModel).toBe('server-attested-claim-against-holding-nft');
  });
});

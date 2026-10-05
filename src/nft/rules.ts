/** Shared CaphetBot NFT product rules (mirrors CaphetBotNFT.sol). Pure data for the mint page and tests. */

export const NFT_MAX_SUPPLY = 1000;
export const NFT_MINT_GEAR = 100;
export const NFT_TREASURY_BPS = 9000;
export const NFT_VAULT_BPS = 1000;

export const RARITY = { common: 0, uncommon: 1, rare: 2, mythic: 3 } as const;
export type RarityId = (typeof RARITY)[keyof typeof RARITY];

export const RARITY_WEIGHTS: Record<RarityId, number> = { 0: 50, 1: 30, 2: 15, 3: 5 };
export const RARITY_DAILY_CAPH: Record<RarityId, number> = { 0: 10, 1: 20, 2: 50, 3: 100 };

export const VAULT_DAY_LIMIT_CAPH = 500_000;
export const VAULT_PER_PAYOUT_LIMIT_CAPH = 10_000;

/** Map a 0..99 roll onto rarity (same bands as the contract). */
export function rarityFromRoll(rollMod100: number): RarityId {
  const roll = ((rollMod100 % 100) + 100) % 100;
  if (roll < 50) return 0;
  if (roll < 80) return 1;
  if (roll < 95) return 2;
  return 3;
}

/** HARD CAP: NFT bot daily CAPH never exceeds the rarity table (and never the vault per-payout limit). */
export function dailyPayoutCaph(rarity: RarityId): number {
  const amount = RARITY_DAILY_CAPH[rarity];
  if (amount > VAULT_PER_PAYOUT_LIMIT_CAPH) throw new Error('rarity payout exceeds vault per-payout limit');
  return amount;
}

/** NFT play is a holding claim, not agent auth. */
export const NFT_SECURITY = {
  grantsAgentApi: false,
  grantsPrivateKey: false,
  downloadableStrategy: false,
  playModel: 'server-attested-claim-against-holding-nft' as const,
  scoreBoostsPayout: false,
};

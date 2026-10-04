import { VOLUME_BEST_USD, VOLUME_WORST_USD } from './constants.js';

/**
 * Coin quality from 24h trading volume in USD.
 * q = 0 at $500 or less (worst coins), q = 1 at $100,000 or more (perfect coins).
 * In between it follows a log scale, so every doubling of volume helps the same amount.
 * The result is rounded to 6 decimals so it is stable across JS engines.
 */
export function qualityFromVolume(volumeUsd: number): number {
  if (!Number.isFinite(volumeUsd) || volumeUsd <= VOLUME_WORST_USD) return 0;
  if (volumeUsd >= VOLUME_BEST_USD) return 1;
  const q = Math.log(volumeUsd / VOLUME_WORST_USD) / Math.log(VOLUME_BEST_USD / VOLUME_WORST_USD);
  return Math.round(q * 1e6) / 1e6;
}

import { FALL_FEE_PERCENT } from './constants.js';

/**
 * Fall fee in whole tokens: ceil(5 percent of the coins on the table at the fall).
 * Integer maths only, so 100 coins is exactly 5, 101 coins is 6, 1000 coins is 50.
 * "Coins on the table" counts every coin of every stack, including the coin that caused the fall.
 */
export function fallFee(coinsOnTable: number): number {
  if (!Number.isInteger(coinsOnTable) || coinsOnTable < 0) throw new Error('coinsOnTable must be a whole number >= 0');
  return Math.floor((coinsOnTable * FALL_FEE_PERCENT + 99) / 100);
}

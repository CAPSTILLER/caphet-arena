/**
 * All tunable numbers for the stacking game live here.
 * Changing any of these changes how a round plays out, so bump ENGINE_VERSION
 * when you do, and old round records must be replayed with the old version.
 */
export const ENGINE_VERSION = 3;

/** Coin geometry, in millimetres. Cap's rule: diameter 63.5 mm. */
export const COIN_DIAMETER_MM = 63.5;
export const COIN_RADIUS_MM = COIN_DIAMETER_MM / 2;
/** Thickness is only used for display height (not for physics). Assumed value. */
export const COIN_THICKNESS_MM = 3;

/**
 * Twin and triple modes: edge gap between first coins is 1.5 coin lengths.
 * Twin: two stacks on a line. Triple: three stacks on an equilateral triangle, so every pair of
 * first coins has this same gap and this same centre distance.
 */
export const STACK_GAP_COINS = 1.5;
export const STACK_GAP_MM = STACK_GAP_COINS * COIN_DIAMETER_MM; // 95.25
/** Distance between the centres of two neighbouring first coins. */
export const STACK_SPACING_MM = COIN_DIAMETER_MM + STACK_GAP_MM; // 158.75

/**
 * The table is a disc centred on the centroid of the first coins. Its radius is the distance from that
 * centroid to the furthest first coin plus this margin. A coin whose centre leaves the disc rolls off.
 */
export const TABLE_MARGIN_MM = 200;

/** Twin and triple: the round score is capped at (second tallest stack's coin count + this). */
export const TEAM_SCORE_CAP_OVER_SECOND = 10;

/** Safety cap on coins per round. Hitting it ends the round like a cash out. */
export const MAX_COINS_PER_ROUND = 120;

/** Offset components (dx, dy) are rounded to this step (mm) so move lists replay exactly. */
export const OFFSET_STEP_MM = 0.1;
/** Positions are rounded to this step (mm). */
export const POSITION_STEP_MM = 0.01;
/** Each offset component is clamped to +/- this many mm before use. */
export const MAX_OFFSET_MM = 2 * COIN_DIAMETER_MM;

/** Volume to quality scale (24h USD volume). q=0 at or below WORST, q=1 at or above BEST. */
export const VOLUME_WORST_USD = 500;
export const VOLUME_BEST_USD = 100_000;

/** Coin imperfection at quality 0 (all scaled by (1 - q)). */
export const COM_MAX_MM = 6.35; // centre of mass can sit up to this far off the coin centre
export const SUPPORT_SHRINK = 0.15; // support radius can shrink by up to 15 percent (misshapen rim)
export const PLACE_NOISE_MM = 8; // hand shake on placement; sd about 0.58 x this x (1 - q), max +/- this x (1 - q) x 2

/** Fall fee: 5 percent of the coins on the table at the fall, rounded up to whole tokens. */
export const FALL_FEE_PERCENT = 5;

/** Ledger: the most the vault pays to a wallet in one payout. A higher score is still recorded in full. */
export const MAX_PAYOUT_TOKENS = 10_000;

import type { Seed } from './prng.js';

export type Mode = 'single' | 'twin' | 'triple';

/** Traits of one coin, set by coin quality. All zero / 1 for a perfect coin. */
export interface CoinTraits {
  /** Where the coin's weight really sits, mm from its geometric centre (x and y). */
  comX: number;
  comY: number;
  /** 1 means the full 31.75 mm support radius. Misshapen coins have less (down to 0.85). */
  supportScale: number;
}

export interface Coin extends CoinTraits {
  /** Centre position on the table plane, mm. */
  x: number;
  y: number;
}

export interface Point {
  x: number;
  y: number;
}

/** A sideways shift of the new coin from the centre of the coin below it, in mm. */
export interface Offset {
  dx: number;
  dy: number;
}

export type Status = 'active' | 'fell' | 'cashed' | 'touched' | 'maxed';

export type FallReason = 'unstable' | 'off_table';

export interface PlaceMove {
  type: 'place';
  stack: number;
  dx: number;
  dy: number;
}
export interface CashOutMove {
  type: 'cashout';
}
export type Move = PlaceMove | CashOutMove;

/** The whole public state of a round. Plain JSON, safe to store in Blob and send to agents. */
export interface RoundState {
  engineVersion: number;
  mode: Mode;
  seed: Seed;
  /** 24h USD volume locked in at round start. */
  volumeUsd: number;
  /** Coin quality 0..1 derived from volumeUsd. */
  quality: number;
  /** Internal PRNG state. */
  rng: number;
  /** Round table: centre and radius. A coin centre outside this disc has left the table. */
  tableCenter: Point;
  tableRadiusMm: number;
  /** Fixed centre of each stack's first coin. */
  homes: Point[];
  stacks: Coin[][];
  /** Traits of the coin you will place next (visible so agents can adapt). */
  next: CoinTraits;
  /** Pairs of stacks that can touch: [] single, [[0,1]] twin, [[0,1],[1,2],[0,2]] triple. */
  pairs: [number, number][];
  /** touching[i] is true once the two stacks of pairs[i] have touched (remembered). */
  touching: boolean[];
  moves: Move[];
  status: Status;
  /** Live score if you cashed out now while active; the final score once the round has ended. For a connect in twin/triple this is the CAPPED score. */
  score: number;
  /** Score before the twin/triple cap (tallest stack coin count). Equals score in every other case. */
  rawScore: number;
  coinsOnTable: number;
  /** Set when status is fell: ceil(5%) of coinsOnTable. Whether anyone pays it is decided by the ledger. */
  fallFee: number;
  fall?: { stack: number; reason: FallReason };
}

/** What gets saved per round (e.g. to Vercel Blob). Everything needed to replay and verify. */
export interface RoundRecord {
  engineVersion: number;
  mode: Mode;
  seed: Seed;
  volumeUsd: number;
  quality: number;
  moves: Move[];
  status: Status;
  score: number;
  rawScore: number;
  coinsOnTable: number;
  fallFee: number;
}

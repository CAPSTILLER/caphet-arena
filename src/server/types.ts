import type { LedgerEntry, Mode, Move, RoundState } from '../index.js';

export interface Seat {
  /** 0..999 inside the mode. */
  index: number;
  /** 0..9 */
  arena: number;
  /** 0..9 */
  subArena: number;
  /** 0..9 */
  table: number;
  /** Position at the table. Always 0 for now: one agent per table (reserved for shared tables). */
  spot: number;
}

export interface WalletDoc {
  wallet: string;
  /** Best registered score ever, stored in full. */
  bestScore: number;
  bestByMode: Partial<Record<Mode, number>>;
  /** Play coins. */
  balance: number;
  plays: number;
  activeRound: string | null;
  house: boolean;
  createdAt: number;
}

export interface RoundDoc {
  id: string;
  wallet: string;
  botName: string;
  house: boolean;
  mode: Mode;
  /** AES-GCM sealed. Never returned while the round is live. */
  seedSealed: string;
  seedCommit: string;
  volumeUsd: number;
  volumeSource: string;
  quality: number;
  /** The only game data we keep. State is rebuilt from seed + volume + moves on every request. */
  moves: Move[];
  seat: Seat;
  ante: number;
  bestAtStart: number;
  startedAt: number;
  lastActiveAt: number;
  endedAt: number | null;
  summary: { status: RoundState['status']; score: number; rawScore: number; coinsOnTable: number };
  ledger: LedgerEntry | null;
  keyHash: string;
  /** Onchain record state. Absent when chain records are off or this round is not recorded (house bots). */
  chain?: { status: 'pending' | 'recorded' | 'failed'; txHash?: string; error?: string; attempts: number };
}

export interface VaultDoc {
  balance: number;
  treasury: number;
  totals: { anteIn: number; paidOut: number; feesToTreasury: number; rounds: number; houseTopUps: number };
}

export interface LeaderboardEntry {
  wallet: string;
  botName: string;
  house: boolean;
  mode: Mode;
  /** Best recorded score in this mode (capped team score for twin/triple, never cut by the payout cap). */
  score: number;
  rawScore: number;
  roundId: string;
  at: number;
}

export type GameEvent =
  | { seq: number; t: number; type: 'join'; roundId: string; mode: Mode; wallet: string; botName: string; house: boolean; seat: Seat; ante: number; volumeUsd: number; quality: number; homes: { x: number; y: number }[] }
  | { seq: number; t: number; type: 'place'; roundId: string; mode: Mode; stack: number; layer: number; x: number; y: number; status: string; coinsOnTable: number; score: number }
  | { seq: number; t: number; type: 'end'; roundId: string; mode: Mode; outcome: string; status: string; score: number; rawScore: number; payout: number; ante: number; vaultToTreasury: number; newBestScore: number };

export type NewEvent = GameEvent extends infer E ? (E extends { seq: number; t: number } ? Omit<E, 'seq' | 't'> : never) : never;

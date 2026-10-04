import { createHash } from 'node:crypto';
import { ARCHETYPES } from '../bots/archetypes.js';
import { playHouseRound } from '../bots/runner.js';
import { qualityFromVolume } from '../quality.js';
import type { Mode, Move } from '../types.js';

/**
 * Watch-only demo: every seat of every mode is always playing a house bot round.
 * Nothing is stored for a round. A round is a pure function of its id, and the id carries
 * everything needed: mode, seat, time slot and the locked volume. Same id, same round, on any machine.
 *
 *   id = d-<mode>-<seat 0000..0999>-<slot number>-<volume in whole dollars>
 */

export const MODES: Mode[] = ['single', 'twin', 'triple'];
export const SEATS_PER_MODE = 1000;
/** One round per seat per slot. The slot number is floor(unix ms / SLOT_MS). */
export const SLOT_MS = 60_000;
/** Longest a bot may play in the demo (placed coins). Keeps rounds inside the slot. */
export const MAX_PLACEMENTS = 60;
/** All of a round's moves are shown within this window after the table's start delay. */
export const PLAY_WINDOW_MS = 35_000;
export const MAX_START_DELAY_MS = 15_000;
export const MIN_STEP_MS = 500;
export const MAX_STEP_MS = 1800;
export const DEMO_SALT = 'caphet-arena-demo-v1';

export interface DemoSeat {
  index: number;
  arena: number;
  subArena: number;
  table: number;
  spot: 0;
}

export function seatFromIndex(index: number): DemoSeat {
  return { index, arena: Math.floor(index / 100), subArena: Math.floor(index / 10) % 10, table: index % 10, spot: 0 };
}

export function seatIndex(arena: number, subArena: number, table: number): number {
  return arena * 100 + subArena * 10 + table;
}

export interface ParsedId {
  mode: Mode;
  seat: number;
  slot: number;
  volumeUsd: number;
}

export function demoRoundId(mode: Mode, seat: number, slot: number, volumeUsd: number): string {
  return `d-${mode}-${String(seat).padStart(4, '0')}-${slot}-${Math.round(volumeUsd)}`;
}

export function parseDemoId(id: string): ParsedId | null {
  const m = /^d-(single|twin|triple)-(\d{4})-(\d{1,9})-(\d{1,12})$/.exec(id);
  if (!m) return null;
  const seat = Number(m[2]);
  if (seat >= SEATS_PER_MODE) return null;
  return { mode: m[1] as Mode, seat, slot: Number(m[3]), volumeUsd: Number(m[4]) };
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Which house archetype sits at a seat. Every sub-arena shows all ten, in a different order per arena. */
export function archetypeIndexFor(seat: number): number {
  const s = seatFromIndex(seat);
  return (s.table + s.subArena + s.arena) % ARCHETYPES.length;
}

export function botLabel(seat: number): string {
  const a = ARCHETYPES[archetypeIndexFor(seat)]!;
  return `${a.name} ${String(seat).padStart(3, '0')}`;
}

export interface DemoPlan {
  roundId: string;
  mode: Mode;
  seat: DemoSeat;
  slot: number;
  botName: string;
  archetype: string;
  house: true;
  seed: string;
  volumeUsd: number;
  quality: number;
  moves: Move[];
  /** When this table starts moving, after the slot begins. */
  startDelayMs: number;
  /** Time between two moves. */
  stepMs: number;
  /** Result of the finished round (what a replay must give). */
  result: { status: string; score: number; rawScore: number; coinsOnTable: number; fallFee: number };
}

export function seedFor(id: string): string {
  return sha(`${DEMO_SALT}:${id}`).slice(0, 32);
}

/** Play the round for a parsed id with the real engine and the real house bot. */
export function planFromId(id: string): DemoPlan | null {
  const p = parseDemoId(id);
  if (!p) return null;
  const seed = seedFor(id);
  const arche = ARCHETYPES[archetypeIndexFor(p.seat)]!;
  const { state } = playHouseRound({ mode: p.mode, seed, volumeUsd: p.volumeUsd, archetype: arche, botSeed: `${seed}:bot`, maxPlacements: MAX_PLACEMENTS });
  const n = state.moves.length;
  const startDelayMs = parseInt(sha(`${id}:delay`).slice(0, 6), 16) % (MAX_START_DELAY_MS + 1);
  const stepMs = Math.max(MIN_STEP_MS, Math.min(MAX_STEP_MS, Math.floor(PLAY_WINDOW_MS / Math.max(1, n))));
  return {
    roundId: id,
    mode: p.mode,
    seat: seatFromIndex(p.seat),
    slot: p.slot,
    botName: botLabel(p.seat),
    archetype: arche.id,
    house: true,
    seed,
    volumeUsd: p.volumeUsd,
    quality: qualityFromVolume(p.volumeUsd),
    moves: state.moves,
    startDelayMs,
    stepMs,
    result: { status: state.status, score: state.score, rawScore: state.rawScore, coinsOnTable: state.coinsOnTable, fallFee: state.fallFee },
  };
}

export const planFor = (mode: Mode, seat: number, slot: number, volumeUsd: number): DemoPlan => planFromId(demoRoundId(mode, seat, slot, volumeUsd))!;

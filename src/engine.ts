import {
  COIN_DIAMETER_MM,
  COIN_RADIUS_MM,
  COIN_THICKNESS_MM,
  COM_MAX_MM,
  ENGINE_VERSION,
  MAX_COINS_PER_ROUND,
  MAX_OFFSET_MM,
  OFFSET_STEP_MM,
  PLACE_NOISE_MM,
  POSITION_STEP_MM,
  STACK_SPACING_MM,
  TEAM_SCORE_CAP_OVER_SECOND,
  SUPPORT_SHRINK,
  TABLE_MARGIN_MM,
} from './constants.js';
import { fallFee } from './fees.js';
import { nextRandom, seedToUint32, type Seed } from './prng.js';
import { qualityFromVolume } from './quality.js';
import type { Coin, CoinTraits, FallReason, Mode, Move, Offset, Point, RoundRecord, RoundState } from './types.js';

export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineError';
  }
}

export const STACK_COUNT: Record<Mode, number> = { single: 1, twin: 2, triple: 3 };

// Round to a decimal step by scaling to integers, so results like 158.75 stay exact decimals.
const round = (v: number, step: number): number => {
  const inv = Math.round(1 / step);
  return Math.round(v * inv) / inv;
};
const cleanPos = (v: number): number => round(v, POSITION_STEP_MM);

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * SINGLE STACK SCORE (confirmed by Cap).
 *
 * Score in whole millimetres = how far the furthest coin sticks out sideways past the edge of
 * the base (first) coin. Every coin has the same diameter, so the overhang of a coin's outer
 * edge past the base coin's edge equals the sideways distance between its centre and the base
 * coin's centre (straight line distance on the table plane, any direction). We take the largest
 * such distance and round DOWN to a whole mm. 1 token per mm. A fall scores 0.
 *
 * To change the rule, change only this function.
 */
export function overhangScoreMm(stack: readonly Coin[]): number {
  const base = stack[0];
  if (!base) return 0;
  let reach = 0;
  for (const c of stack) {
    const shift = Math.hypot(c.x - base.x, c.y - base.y);
    if (shift > reach) reach = shift;
  }
  return Math.floor(reach + 1e-6);
}

/** Number of coins in the tallest stack (the raw score for twin and triple before the cap). */
export function tallestStackCoins(stacks: readonly (readonly Coin[])[]): number {
  let best = 0;
  for (const s of stacks) if (s.length > best) best = s.length;
  return best;
}

/**
 * Twin and triple round score. raw = coins in the tallest stack. The score that counts is capped at
 * (coins in the second tallest stack + 10); for triple the second tallest is the second of the three,
 * for twin it is the other stack. This stops one huge tower from carrying a round.
 */
export function teamScore(stacks: readonly (readonly Coin[])[]): { raw: number; capped: number } {
  const counts = stacks.map((st) => st.length).sort((a, b) => b - a);
  const raw = counts[0] ?? 0;
  const second = counts[1] ?? 0;
  return { raw, capped: Math.min(raw, second + TEAM_SCORE_CAP_OVER_SECOND) };
}

/** What you would be paid if you cashed out right now. Multi stack modes pay 0 until they touch. */
export function currentScore(state: RoundState): number {
  if (state.status !== 'active') return state.score;
  if (state.mode === 'single') return overhangScoreMm(state.stacks[0] ?? []);
  return 0;
}

/** Display height of a stack in mm. */
export function stackHeightMm(stack: readonly Coin[]): number {
  return stack.length * COIN_THICKNESS_MM;
}

// ---------------------------------------------------------------------------
// Stability
// ---------------------------------------------------------------------------

/**
 * How much room a stack has before it falls, in mm (negative means it has fallen).
 *
 * For every coin k that has coins above it, take the centre of mass of all the coins above k
 * (each coin's weight sits at its centre plus its comX, comY). It must stay inside coin k's
 * support, a disc of radius 31.75 mm x supportScale around coin k's centre. The margin is the
 * smallest distance left over, taken over all k. A stack with one coin has infinite margin.
 */
export function stackMargin(stack: readonly Coin[]): number {
  let margin = Infinity;
  let sx = 0;
  let sy = 0;
  let count = 0;
  for (let k = stack.length - 1; k >= 1; k--) {
    const above = stack[k]!;
    sx += above.x + above.comX;
    sy += above.y + above.comY;
    count++;
    const support = stack[k - 1]!;
    const m = COIN_RADIUS_MM * support.supportScale - Math.hypot(sx / count - support.x, sy / count - support.y);
    if (m < margin) margin = m;
  }
  return margin;
}

/** Distance left before the furthest coin centre of this stack leaves the table disc (negative = off the table). */
function tableMargin(state: Pick<RoundState, 'tableCenter' | 'tableRadiusMm'>, stack: readonly Coin[]): number {
  let m = Infinity;
  for (const c of stack) {
    m = Math.min(m, state.tableRadiusMm - Math.hypot(c.x - state.tableCenter.x, c.y - state.tableCenter.y));
  }
  return m;
}

/**
 * Noise-free preview of what a placement would do, using the visible next coin traits.
 * Real placement adds hidden hand-shake noise (zero at quality 1), so keep a safety gap.
 */
export function previewPlacement(
  state: RoundState,
  stackIndex: number,
  offset: Offset | number,
): { x: number; y: number; margin: number; tableMargin: number } {
  const stack = state.stacks[stackIndex];
  if (!stack) throw new EngineError('no such stack');
  const top = stack[stack.length - 1]!;
  const o = normalizeOffset(offset);
  const x = cleanPos(top.x + o.dx);
  const y = cleanPos(top.y + o.dy);
  const hypo = [...stack, { x, y, ...state.next }];
  return { x, y, margin: stackMargin(hypo), tableMargin: tableMargin(state, hypo) };
}

/**
 * Convenience for agents that think in direction and distance. Angle 0 is toward +x, 90 is toward +y.
 * The engine only ever stores the resulting dx, dy (rounded to 0.1 mm), so replays never need trig.
 */
export function offsetFromPolar(distanceMm: number, angleDeg: number): Offset {
  const a = (angleDeg * Math.PI) / 180;
  return { dx: distanceMm * Math.cos(a), dy: distanceMm * Math.sin(a) };
}

/** Offset of length distanceMm pointing from (fromX, fromY) toward (toX, toY). Zero if the points coincide. */
export function offsetToward(fromX: number, fromY: number, toX: number, toY: number, distanceMm: number): Offset {
  const d = Math.hypot(toX - fromX, toY - fromY);
  if (d === 0) return { dx: 0, dy: 0 };
  return { dx: ((toX - fromX) / d) * distanceMm, dy: ((toY - fromY) / d) * distanceMm };
}

// ---------------------------------------------------------------------------
// Round lifecycle
// ---------------------------------------------------------------------------

function drawTraits(rng: number, quality: number): [CoinTraits, number] {
  const [u1, r1] = nextRandom(rng);
  const [u2, r2] = nextRandom(r1);
  const [u3, r3] = nextRandom(r2);
  const imperfection = 1 - quality;
  // each axis gets up to COM_MAX_MM / sqrt(2), so the total off-centre distance is at most COM_MAX_MM
  const comScale = (COM_MAX_MM / Math.SQRT2) * imperfection;
  const comX = round((u1 * 2 - 1) * comScale, POSITION_STEP_MM);
  const comY = round((u2 * 2 - 1) * comScale, POSITION_STEP_MM);
  const supportScale = round(1 - SUPPORT_SHRINK * imperfection * u3, 0.0001);
  return [{ comX: comX === 0 ? 0 : comX, comY: comY === 0 ? 0 : comY, supportScale }, r3];
}

/** Where the first coins sit. Single: one coin. Twin: two on a line. Triple: an equilateral triangle. */
function homePositions(mode: Mode): Point[] {
  const d = STACK_SPACING_MM;
  if (mode === 'single') return [{ x: 0, y: 0 }];
  if (mode === 'twin') return [{ x: 0, y: 0 }, { x: cleanPos(d), y: 0 }];
  return [
    { x: 0, y: 0 },
    { x: cleanPos(d), y: 0 },
    { x: cleanPos(d / 2), y: cleanPos((d * Math.sqrt(3)) / 2) },
  ];
}

const PAIRS: Record<Mode, [number, number][]> = {
  single: [],
  twin: [[0, 1]],
  triple: [[0, 1], [1, 2], [0, 2]],
};

/**
 * Start a round. Pure: same inputs always give the same state.
 * The volume you pass is locked into the round and stored in the state.
 * Base coins are already on the table (1 in single, 2 in twin, 3 in triple).
 */
export function createRound(mode: Mode, seed: Seed, volumeUsd: number): RoundState {
  if (!(mode in STACK_COUNT)) throw new EngineError(`unknown mode ${String(mode)}`);
  if (!Number.isFinite(volumeUsd) || volumeUsd < 0) throw new EngineError('volumeUsd must be a number >= 0');
  const quality = qualityFromVolume(volumeUsd);
  let rng = seedToUint32(seed);
  const homes = homePositions(mode);
  const stacks: Coin[][] = [];
  for (const h of homes) {
    const [traits, r] = drawTraits(rng, quality);
    rng = r;
    stacks.push([{ x: h.x, y: h.y, ...traits }]);
  }
  const [next, r] = drawTraits(rng, quality);
  const cx = homes.reduce((a, h) => a + h.x, 0) / homes.length;
  const cy = homes.reduce((a, h) => a + h.y, 0) / homes.length;
  const center = { x: cleanPos(cx), y: cleanPos(cy) };
  const furthest = Math.max(...homes.map((h) => Math.hypot(h.x - center.x, h.y - center.y)));
  const state: RoundState = {
    engineVersion: ENGINE_VERSION,
    mode,
    seed,
    volumeUsd,
    quality,
    rng: r,
    tableCenter: center,
    tableRadiusMm: cleanPos(furthest + TABLE_MARGIN_MM),
    homes,
    stacks,
    next,
    pairs: PAIRS[mode].map((p) => [...p] as [number, number]),
    touching: new Array<boolean>(PAIRS[mode].length).fill(false),
    moves: [],
    status: 'active',
    score: 0,
    rawScore: 0,
    coinsOnTable: homes.length,
    fallFee: 0,
  };
  state.score = currentScore(state);
  state.rawScore = state.score;
  return state;
}

function cloneState(s: RoundState): RoundState {
  return {
    ...s,
    tableCenter: { ...s.tableCenter },
    homes: s.homes.map((h) => ({ ...h })),
    stacks: s.stacks.map((st) => st.map((c) => ({ ...c }))),
    next: { ...s.next },
    pairs: s.pairs.map((p) => [...p] as [number, number]),
    touching: [...s.touching],
    moves: s.moves.map((m) => ({ ...m })),
    fall: s.fall ? { ...s.fall } : undefined,
  };
}

function clampComponent(v: number): number {
  const q = round(v, OFFSET_STEP_MM);
  return Math.max(-MAX_OFFSET_MM, Math.min(MAX_OFFSET_MM, q === 0 ? 0 : q));
}

/** A bare number means "along +x" (dy = 0), handy for single and twin. Components are rounded to 0.1 mm. */
function normalizeOffset(o: Offset | number): Offset {
  if (typeof o === 'number') return { dx: clampComponent(o), dy: 0 };
  return { dx: clampComponent(o.dx), dy: clampComponent(o.dy) };
}

/** True when the touch graph connects every stack (a chain of touches is enough). */
export function allConnected(stackCount: number, pairs: readonly [number, number][], touching: readonly boolean[]): boolean {
  if (stackCount <= 1) return false;
  const parent = Array.from({ length: stackCount }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  pairs.forEach(([a, b], i) => {
    if (touching[i]) parent[find(a)] = find(b);
  });
  const root = find(0);
  for (let i = 1; i < stackCount; i++) if (find(i) !== root) return false;
  return true;
}

function requireActive(state: RoundState): void {
  if (state.status !== 'active') throw new EngineError(`round is over (${state.status})`);
}

/**
 * Place the next coin on top of a stack, shifted sideways from the centre of the coin below by
 * `offset` = { dx, dy } in mm (a bare number means { dx: number, dy: 0 }). Components are rounded to
 * 0.1 mm. +x points from stack 0 toward stack 1; +y points up the page toward stack 2 in triple mode.
 * Pure: returns a new state, the input is untouched. Throws EngineError for illegal calls
 * (round over, bad stack, non-finite offset).
 *
 * Outcomes: the stack falls (score 0), the stacks touch (round ends with the score),
 * or the round carries on. Hidden hand-shake noise (shrinks to 0 at quality 1) moves the coin a bit.
 */
export function placeCoin(state: RoundState, offset: Offset | number, stackIndex = 0): RoundState {
  requireActive(state);
  const raw = typeof offset === 'number' ? { dx: offset, dy: 0 } : offset;
  if (!raw || !Number.isFinite(raw.dx) || !Number.isFinite(raw.dy)) throw new EngineError('offset must be finite numbers');
  if (!Number.isInteger(stackIndex) || stackIndex < 0 || stackIndex >= state.stacks.length) {
    throw new EngineError('no such stack');
  }
  const s = cloneState(state);
  const o = normalizeOffset(raw);
  const move: Move = { type: 'place', stack: stackIndex, dx: o.dx, dy: o.dy };

  // Draw 8 noise numbers (4 per axis), then the next coin: always the same number of draws.
  let rng = s.rng;
  const noise: number[] = [];
  for (let axis = 0; axis < 2; axis++) {
    let sum = 0;
    for (let i = 0; i < 4; i++) {
      const [u, r] = nextRandom(rng);
      sum += u;
      rng = r;
    }
    noise.push((sum - 2) * PLACE_NOISE_MM * (1 - s.quality));
  }
  const placed = s.next;
  const [nextTraits, r2] = drawTraits(rng, s.quality);
  s.rng = r2;
  s.next = nextTraits;

  const stack = s.stacks[stackIndex]!;
  const top = stack[stack.length - 1]!;
  const coin: Coin = { x: cleanPos(top.x + o.dx + noise[0]!), y: cleanPos(top.y + o.dy + noise[1]!), ...placed };
  stack.push(coin);
  s.coinsOnTable += 1;
  s.moves.push(move);

  // Fall check (only the stack we touched can have changed).
  let reason: FallReason | null = null;
  if (tableMargin(s, stack) < 0) reason = 'off_table';
  else if (stackMargin(stack) < 0) reason = 'unstable';
  if (reason) {
    s.status = 'fell';
    s.score = 0;
    s.rawScore = 0;
    s.fallFee = fallFee(s.coinsOnTable);
    s.fall = { stack: stackIndex, reason };
    return s;
  }

  // Touch check: the new coin can only touch the same layer of another stack.
  const layer = stack.length - 1;
  s.pairs.forEach(([a, b], i) => {
    if (a !== stackIndex && b !== stackIndex) return;
    const ca = s.stacks[a]![layer];
    const cb = s.stacks[b]![layer];
    if (ca && cb && Math.hypot(cb.x - ca.x, cb.y - ca.y) <= COIN_DIAMETER_MM + 1e-6) s.touching[i] = true;
  });
  if (allConnected(s.stacks.length, s.pairs, s.touching)) {
    s.status = 'touched';
    const t = teamScore(s.stacks);
    s.rawScore = t.raw;
    s.score = t.capped;
    return s;
  }

  if (s.coinsOnTable >= MAX_COINS_PER_ROUND) {
    s.status = 'maxed';
    s.score = currentScore({ ...s, status: 'active' });
    s.rawScore = s.score;
    return s;
  }
  s.score = currentScore(s);
  s.rawScore = s.score;
  return s;
}

/**
 * Stop and keep the current score. Single stack: the overhang so far.
 * Twin and triple: stacks that have not all touched score 0 (no fee either, since nothing fell).
 */
export function cashOut(state: RoundState): RoundState {
  requireActive(state);
  const s = cloneState(state);
  s.moves.push({ type: 'cashout' });
  s.score = currentScore(state);
  s.rawScore = s.score;
  s.status = 'cashed';
  return s;
}

/** Apply one saved move to a state. */
export function applyMove(state: RoundState, move: Move): RoundState {
  if (move.type === 'cashout') return cashOut(state);
  if (move.type === 'place') return placeCoin(state, { dx: move.dx, dy: move.dy }, move.stack);
  throw new EngineError('unknown move type');
}

export type ReplayResult =
  | { ok: true; state: RoundState }
  | { ok: false; error: string; movesApplied: number; state: RoundState };

/**
 * Rebuild a round from seed + mode + locked volume + move list.
 * Same inputs always give exactly the same final state. If a move is illegal (for example a
 * move after the round ended) it stops there and reports ok=false with the state so far.
 */
export function replay(seed: Seed, mode: Mode, volumeUsd: number, moves: readonly Move[]): ReplayResult {
  let state = createRound(mode, seed, volumeUsd);
  for (let i = 0; i < moves.length; i++) {
    try {
      state = applyMove(state, moves[i]!);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), movesApplied: i, state };
    }
  }
  return { ok: true, state };
}

/** Compact record to save per round. */
export function toRecord(state: RoundState): RoundRecord {
  return {
    engineVersion: state.engineVersion,
    mode: state.mode,
    seed: state.seed,
    volumeUsd: state.volumeUsd,
    quality: state.quality,
    moves: state.moves.map((m) => ({ ...m })),
    status: state.status,
    score: state.score,
    rawScore: state.rawScore,
    coinsOnTable: state.coinsOnTable,
    fallFee: state.fallFee,
  };
}

/** Replay a saved record and check it claims the true result. */
export function verifyRecord(record: RoundRecord): { valid: boolean; reason?: string; state?: RoundState } {
  if (record.engineVersion !== ENGINE_VERSION) return { valid: false, reason: 'engine version mismatch' };
  const r = replay(record.seed, record.mode, record.volumeUsd, record.moves);
  if (!r.ok) return { valid: false, reason: r.error, state: r.state };
  const s = r.state;
  if (s.status !== record.status) return { valid: false, reason: 'status differs', state: s };
  if (s.score !== record.score) return { valid: false, reason: 'score differs', state: s };
  if (s.rawScore !== record.rawScore) return { valid: false, reason: 'raw score differs', state: s };
  if (s.coinsOnTable !== record.coinsOnTable) return { valid: false, reason: 'coin count differs', state: s };
  if (s.fallFee !== record.fallFee) return { valid: false, reason: 'fee differs', state: s };
  if (s.quality !== record.quality) return { valid: false, reason: 'quality differs', state: s };
  return { valid: true, state: s };
}

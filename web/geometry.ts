// Ring layouts and overview colours for the arena of arenas. Pure functions, tested without a page.

export interface RingSlot { x: number; y: number; r: number; angle: number }
export interface Ring { ringRadius: number; circleRadius: number; positions: RingSlot[] }

/** `count` equal circles in a ring that fits inside a circle of radius maxRadius around (cx, cy). Slot 0 is at 12 o'clock. */
export function ringPositions(cx: number, cy: number, maxRadius: number, count = 10): Ring {
  const sin = Math.sin(Math.PI / count);
  const ringRadius = maxRadius / (1 + sin);
  const circleRadius = ringRadius * sin * 0.96;
  const positions: RingSlot[] = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
    positions.push({ x: cx + Math.cos(angle) * ringRadius, y: cy + Math.sin(angle) * ringRadius, r: circleRadius, angle });
  }
  return { ringRadius, circleRadius, positions };
}

/** Which slot is under the point, or -1. */
export function hitRing(ring: Ring, x: number, y: number): number {
  for (let i = 0; i < ring.positions.length; i++) {
    const p = ring.positions[i]!;
    if (Math.hypot(x - p.x, y - p.y) <= p.r) return i;
  }
  return -1;
}

export type Phase = 'wait' | 'play' | 'fell' | 'cashed' | 'touched';
export interface Cell { phase: Phase; coins: number; size: number }

/**
 * What one table looks like at this moment, from the compact overview row
 * [startDelayMs, stepMs, moves, end, score, coinsOnTable] (end: 1 fell, 2 cashed out, 3 stacks connected).
 * This is only for colouring the overview. Table close-ups are replayed exactly by the engine.
 */
export function liveCell(row: readonly number[] | undefined, sinceSlotStartMs: number): Cell {
  if (!row) return { phase: 'wait', coins: 0, size: 0 };
  const [delay, step, moves, end, , coinsEnd] = row as [number, number, number, number, number, number];
  const t = sinceSlotStartMs - delay;
  if (t < 0) return { phase: 'wait', coins: 0, size: 0 };
  const k = Math.min(moves, Math.floor(t / Math.max(1, step)) + 1);
  const coins = k >= moves ? coinsEnd : Math.round((coinsEnd * k) / Math.max(1, moves));
  const size = Math.min(1, 0.16 + 0.84 * Math.min(1, coins / 60));
  if (k < moves) return { phase: 'play', coins, size };
  return { phase: end === 1 ? 'fell' : end === 3 ? 'touched' : 'cashed', coins, size };
}

export interface Tally { size: number; play: number; fell: number; cashed: number; wait: number; coins: number }
/** Roll up the cells of a group of tables (a sub-arena or an arena). size is the mean disc size, 0 to 1. */
export function tally(cells: readonly Cell[]): Tally {
  const t: Tally = { size: 0, play: 0, fell: 0, cashed: 0, wait: 0, coins: 0 };
  for (const c of cells) {
    t.size += c.size;
    t.coins += c.coins;
    if (c.phase === 'play') t.play++;
    else if (c.phase === 'fell') t.fell++;
    else if (c.phase === 'wait') t.wait++;
    else t.cashed++;
  }
  t.size = cells.length ? t.size / cells.length : 0;
  return t;
}

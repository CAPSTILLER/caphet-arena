// Ring layouts and overview colours for the arena of arenas. Pure functions, tested without a page.

/** How much of the space between neighbours the circles use. 1 would make them touch exactly, 0.99 keeps them from overlapping. */
export const TIGHT = 0.99;

export interface RingSlot { x: number; y: number; r: number; angle: number }
export interface Ring { ringRadius: number; circleRadius: number; positions: RingSlot[] }

/** `count` equal circles in a ring that fits inside a circle of radius maxRadius around (cx, cy). Slot 0 is at 12 o'clock. */
export function ringPositions(cx: number, cy: number, maxRadius: number, count = 10): Ring {
  const sin = Math.sin(Math.PI / count);
  const ringRadius = maxRadius / (1 + sin);
  const circleRadius = ringRadius * sin * TIGHT;
  const positions: RingSlot[] = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
    positions.push({ x: cx + Math.cos(angle) * ringRadius, y: cy + Math.sin(angle) * ringRadius, r: circleRadius, angle });
  }
  return { ringRadius, circleRadius, positions };
}

/** The hub circle that sits in the middle and touches the inside of every circle of the ring. */
export function hubRadius(ring: Ring): number { return ring.ringRadius - ring.circleRadius; }

export interface HubLayout {
  /** The slots exactly as ringPositions gives them. Everything drawn inside a slot (nested rings, tables, labels) uses these circles, so contents never change size. */
  ring: Ring;
  /** Hub radius for this volume setting. */
  hubR: number;
  /** The "petal" behind each slot: a circle of radius petalR centred petalDist from the middle, cut by the straight lines halfway to the neighbours. */
  petalR: number;
  petalDist: number;
  /** The petal also includes the whole pie slice (between the straight lines) out to this distance from the middle, so no gap is left around the hub. Equal to hubR at the biggest hub, petalDist at the smallest. */
  sectorR: number;
  cx: number; cy: number;
  /** Radius of the outer edge of the petals (the same as the outer edge of the ring slots). */
  outerR: number;
}

/**
 * Layout for a hub that shrinks with coin volume. t is 0 to 1 (0: the hub is as big as the tight ring allows, 1: the hub is about the size of one slot circle).
 * Ten equal circles cannot grow and stay both tight to a smaller hub and apart from each other inside the same outer edge, so each slot's
 * backdrop becomes a petal: a bigger circle that touches the hub, cut by straight lines halfway to its neighbours (so petals touch and never overlap).
 * At t = 0 the petal is exactly today's circle. The slot circle itself (ring) never changes.
 */
export function hubLayout(cx: number, cy: number, maxRadius: number, t: number, count = 10): HubLayout {
  const ring = ringPositions(cx, cy, maxRadius, count);
  const k = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  const hub0 = hubRadius(ring);
  const outerR = ring.ringRadius + ring.circleRadius;
  const hubR = hub0 + (ring.circleRadius - hub0) * k;
  const petalR = (outerR - hubR) / 2;
  const petalDist = hubR + petalR;
  return { ring, hubR, petalR, petalDist, sectorR: hubR + k * (petalDist - hubR), cx, cy, outerR };
}

/** Which slot is under the point of a hub layout: -2 for the hub, -1 for nothing, else the slot. */
export function hitLayout(l: HubLayout, x: number, y: number): number {
  const dx = x - l.cx, dy = y - l.cy;
  const d = Math.hypot(dx, dy);
  if (d < l.hubR) return -2;
  const n = l.ring.positions.length;
  const a = Math.atan2(dy, dx) + Math.PI / 2; // 0 at 12 o'clock
  const i = (((Math.round((a / (Math.PI * 2)) * n) % n) + n) % n);
  const ang = l.ring.positions[i]!.angle;
  const px = l.cx + Math.cos(ang) * l.petalDist, py = l.cy + Math.sin(ang) * l.petalDist;
  if (d <= l.sectorR) return i;
  return Math.hypot(x - px, y - py) <= l.petalR ? i : -1;
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
export interface Cell {
  phase: Phase;
  /** Whole coins on the table right now. */
  coins: number;
  /** Coins on the table, growing smoothly while a new coin slides in (for animation). */
  coinsF: number;
  /** 0 to 1, from the number of coins (60 is a full stack). */
  size: number;
  /** Milliseconds since this table last placed a coin (a very large number if it has not started). */
  sinceMove: number;
  /** 1 right when a round ends (fall, cash out, connect), fading to 0 over about 1.4 seconds. */
  flash: number;
}

export const FLASH_MS = 1400;
const NOT_STARTED: Cell = { phase: 'wait', coins: 0, coinsF: 0, size: 0, sinceMove: 1e9, flash: 0 };

/**
 * What one table looks like at this moment, from the compact overview row
 * [startDelayMs, stepMs, moves, end, score, coinsOnTable] (end: 1 fell, 2 cashed out, 3 stacks connected).
 * This is only for colouring and animating the overview. Table close-ups are replayed exactly by the engine.
 */
export function liveCell(row: readonly number[] | undefined, sinceSlotStartMs: number): Cell {
  if (!row) return NOT_STARTED;
  const [delay, step0, moves, end, , coinsEnd] = row as [number, number, number, number, number, number];
  const step = Math.max(1, step0);
  const t = sinceSlotStartMs - delay;
  if (t < 0) return NOT_STARTED;
  const k = Math.min(moves, Math.floor(t / step) + 1);
  const sinceMove = t - (k - 1) * step;
  if (k < moves) {
    const f = Math.min(1, sinceMove / (step * 0.25)); // the new coin slides in during the first quarter of a step
    const coinsF = Math.min(coinsEnd, (coinsEnd * (k - 1 + f)) / Math.max(1, moves));
    const coins = Math.round((coinsEnd * k) / Math.max(1, moves));
    return { phase: 'play', coins, coinsF, size: Math.min(1, 0.16 + 0.84 * Math.min(1, coinsF / 60)), sinceMove, flash: 0 };
  }
  const flash = Math.max(0, 1 - sinceMove / FLASH_MS);
  return { phase: end === 1 ? 'fell' : end === 3 ? 'touched' : 'cashed', coins: coinsEnd, coinsF: coinsEnd, size: Math.min(1, 0.16 + 0.84 * Math.min(1, coinsEnd / 60)), sinceMove, flash };
}

export interface Tally { size: number; play: number; fell: number; cashed: number; wait: number; coins: number; pulse: number; flash: number }
/** Roll up the cells of a group of tables (a sub-arena or an arena). size is the mean disc size, 0 to 1. */
export function tally(cells: readonly Cell[]): Tally {
  const t: Tally = { size: 0, play: 0, fell: 0, cashed: 0, wait: 0, coins: 0, pulse: 0, flash: 0 };
  for (const c of cells) {
    t.size += c.size;
    t.coins += c.coins;
    if (c.phase === 'play') { t.play++; t.pulse = Math.max(t.pulse, 1 - Math.min(1, c.sinceMove / 300)); }
    else if (c.phase === 'fell') { t.fell++; t.flash = Math.max(t.flash, c.flash); }
    else if (c.phase === 'wait') t.wait++;
    else { t.cashed++; t.flash = Math.max(t.flash, c.flash); }
  }
  t.size = cells.length ? t.size / cells.length : 0;
  return t;
}

/** Start and end angle (radians) of the arc for table i of n, drawn as a ring of n short arcs with small gaps. 0 is at 12 o'clock. */
export function arcFor(i: number, n = 10, gapFrac = 0.18): [number, number] {
  const step = (Math.PI * 2) / n;
  const a0 = -Math.PI / 2 + i * step + (step * gapFrac) / 2;
  return [a0, a0 + step * (1 - gapFrac)];
}

/** Where the stack spots of one table sit inside its circle (radius 1): 1 for single, 2 for twin, 3 for triple. */
export function spotsFor(count: number): { x: number; y: number; r: number }[] {
  if (count <= 1) return [{ x: 0, y: 0, r: 1 }];
  if (count === 2) return [{ x: -0.5, y: 0, r: 0.46 }, { x: 0.5, y: 0, r: 0.46 }];
  return [{ x: 0, y: -0.52, r: 0.42 }, { x: -0.46, y: 0.3, r: 0.42 }, { x: 0.46, y: 0.3, r: 0.42 }];
}

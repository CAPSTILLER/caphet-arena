import { COIN_RADIUS_MM } from '../constants.js';
import { previewPlacement } from '../engine.js';
import type { Offset, RoundState } from '../types.js';

const R = COIN_RADIUS_MM;

export function height(state: RoundState, stack: number): number {
  return state.stacks[stack]!.length;
}

/** Stack index -> component id, from the touch graph (stacks that touched are in the same component). */
export function components(state: RoundState): number[] {
  const comp = state.stacks.map((_, i) => i);
  const find = (i: number): number => (comp[i] === i ? i : (comp[i] = find(comp[i]!)));
  state.pairs.forEach(([a, b], i) => {
    if (state.touching[i]) comp[find(a)] = find(b);
  });
  return comp.map((_, i) => find(i));
}

/**
 * Which stack to add to next, and the unit direction it should lean.
 * Single: stack 0, lean +x.
 * Twin: both lean toward each other.
 * Triple (equilateral triangle): each stack leans toward the middle of the stacks it is not yet connected to.
 * With all three apart that is the centre of the triangle, so all three lean inward together.
 * Always adds to the shortest stack (ties go to the lower index), so same-layer coins exist to touch.
 */
export function pickStack(state: RoundState): { stack: number; dir: { x: number; y: number } } {
  if (state.stacks.length === 1) return { stack: 0, dir: { x: 1, y: 0 } };
  let stack = 0;
  for (let s = 1; s < state.stacks.length; s++) if (height(state, s) < height(state, stack)) stack = s;
  const comp = components(state);
  const others = state.homes.filter((_, i) => comp[i] !== comp[stack]);
  const target = others.length ? others : state.homes.filter((_, i) => i !== stack);
  const tx = target.reduce((a, p) => a + p.x, 0) / target.length;
  const ty = target.reduce((a, p) => a + p.y, 0) / target.length;
  const home = state.homes[stack]!;
  const d = Math.hypot(tx - home.x, ty - home.y) || 1;
  return { stack, dir: { x: (tx - home.x) / d, y: (ty - home.y) / d } };
}

const along = (dir: { x: number; y: number }, mag: number): Offset => ({ dx: dir.x * mag, dy: dir.y * mag });

/**
 * Pick a lean of length up to `wanted` mm along `dir` that keeps the preview margin at least safetyMm.
 * Walks from the wanted length toward 0 in 0.5 mm steps. If nothing works, tries leaning the other way,
 * then falls back to the most stable lean along that line.
 */
export function safeOffset(state: RoundState, stack: number, dir: { x: number; y: number }, wanted: number, safetyMm: number): Offset {
  const ok = (mag: number): boolean => {
    const p = previewPlacement(state, stack, along(dir, mag));
    return p.margin >= safetyMm && p.tableMargin >= safetyMm;
  };
  const sign = wanted < 0 ? -1 : 1;
  for (let a = Math.abs(wanted); a >= 0; a -= 0.5) {
    if (ok(sign * a)) return along(dir, sign * a);
  }
  for (let a = 0; a <= 2 * R; a += 0.5) {
    if (ok(-sign * a)) return along(dir, -sign * a);
  }
  let best = 0;
  let bestM = -Infinity;
  for (let o = -R; o <= R; o += 0.5) {
    const m = previewPlacement(state, stack, along(dir, o)).margin;
    if (m > bestM) {
      bestM = m;
      best = o;
    }
  }
  return along(dir, best);
}

/** The ideal harmonic lean for the j-th coin (1-based) of an m coin leaning run: R / (m - j + 1). */
export function harmonicStep(j: number, m: number): number {
  return R / (m - j + 1);
}

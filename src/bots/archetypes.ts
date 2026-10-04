import { COIN_RADIUS_MM } from '../constants.js';
import { currentScore } from '../engine.js';
import type { Mode, RoundState } from '../types.js';
import { harmonicStep, height, pickStack, safeOffset } from './helpers.js';
import type { BotAction, BotArchetype, Decider } from './types.js';

const R = COIN_RADIUS_MM;
const place = (stack: number, o: { dx: number; dy: number }): BotAction => ({ type: 'place', stack, dx: o.dx, dy: o.dy });
const ZERO = { dx: 0, dy: 0 };
const CASH: BotAction = { type: 'cashout' };

/** Safe planner: lean as far as the safety margin allows, toward the other stack(s). */
function plannerBot(opts: {
  safetyMm: number;
  /** single mode: cash out once the overhang reaches this many mm */
  singleTargetMm: number;
  /** multi modes: give up (cash out, score 0, no fee) after this many coins on the table */
  giveUpCoins: number;
  /** how far past the safe point the bot dares, mm per coin (gamblers use > 0) */
  greed?: number;
}): Decider {
  return (state) => {
    if (state.mode === 'single') {
      if (currentScore(state) >= opts.singleTargetMm) return CASH;
    } else if (state.coinsOnTable >= opts.giveUpCoins) {
      return CASH;
    }
    const { stack, dir } = pickStack(state);
    return place(stack, safeOffset(state, stack, dir, R + (opts.greed ?? 0), opts.safetyMm));
  };
}

/**
 * Harmonic bot: builds `base` straight coins on each stack, then leans in a run of `run` coins using
 * the ideal harmonic steps R/run, R/(run-1), ... R/1 scaled by `factor`, each clamped by the safety margin.
 */
function harmonicBot(opts: {
  base: number;
  run: number;
  factor: number;
  safetyMm: number;
  giveUpCoins: number;
}): Decider {
  const placedInRun = new Map<string, number>(); // per stack
  return (state) => {
    const single = state.mode === 'single';
    const triple = state.mode === 'triple';
    const run = opts.run;
    const { stack, dir } = pickStack(state);
    const h = height(state, stack);
    if (single) {
      if (h >= opts.base + run) return CASH;
    } else if (state.coinsOnTable >= (triple ? Math.round(opts.giveUpCoins * 1.5) : opts.giveUpCoins)) {
      return CASH;
    }
    if (h < opts.base) return place(stack, ZERO);
    const key = String(stack);
    const j = (placedInRun.get(key) ?? 0) + 1;
    placedInRun.set(key, j);
    const step = j <= run ? harmonicStep(j, run) : R;
    return place(stack, safeOffset(state, stack, dir, step * opts.factor, opts.safetyMm));
  };
}

export const ARCHETYPES: BotArchetype[] = [
  {
    id: 'snail',
    name: 'Snail',
    description: 'Very careful. Leans only where the margin is 8 mm or more, cashes out early.',
    create: () => plannerBot({ safetyMm: 8, singleTargetMm: 25, giveUpCoins: 24 }),
  },
  {
    id: 'steady',
    name: 'Steady Eddie',
    description: 'Safe planner with a 4 mm margin, takes 30 mm then leaves.',
    create: () => plannerBot({ safetyMm: 4, singleTargetMm: 30, giveUpCoins: 30 }),
  },
  {
    id: 'harmonic-short',
    name: 'Harmonic 8',
    description: 'Lean run of 8 coins on harmonic steps at 90 percent of ideal, then cash out.',
    create: () => harmonicBot({ base: 0, run: 8, factor: 0.9, safetyMm: 2, giveUpCoins: 34 }),
  },
  {
    id: 'harmonic-long',
    name: 'Harmonic 14',
    description: 'Tower of 4, then a lean run of 14 harmonic steps at 90 percent of ideal.',
    create: () => harmonicBot({ base: 4, run: 14, factor: 0.9, safetyMm: 2, giveUpCoins: 60 }),
  },
  {
    id: 'pillar',
    name: 'Pillar',
    description: 'Builds straight towers of 10 first (extra weight helps), then leans in a run of 6.',
    create: () => harmonicBot({ base: 10, run: 6, factor: 0.9, safetyMm: 2, giveUpCoins: 70 }),
  },
  {
    id: 'gambler',
    name: 'Gambler',
    description: 'Hugs the edge (0.5 mm margin), always pushes the furthest it can, aims for 70 mm.',
    create: () => plannerBot({ safetyMm: 0.5, singleTargetMm: 70, giveUpCoins: 80, greed: 10 }),
  },
  {
    id: 'zigzag',
    name: 'Zigzag',
    description: 'Alternates a 10 to 14 mm lean toward the target with a smaller lean back, to keep the weight balanced.',
    create: (rng) => {
      let flip = 1;
      return (state) => {
        if (state.mode === 'single') {
          if (currentScore(state) >= 30 || state.coinsOnTable > 24) return CASH;
        } else if (state.coinsOnTable >= 40) return CASH;
        const { stack, dir } = pickStack(state);
        flip = -flip;
        const lean = 10 + 4 * rng();
        const mag = flip > 0 ? lean : -lean * 0.6;
        return place(stack, { dx: dir.x * mag, dy: dir.y * mag });
      };
    },
  },
  {
    id: 'drunk',
    name: 'Drunk',
    description: 'Random 2D offsets up to one radius on each axis, random chance to cash out each turn.',
    create: (rng) => (state) => {
      if (rng() < 0.08) return CASH;
      const { stack } = pickStack(state);
      return place(stack, { dx: (rng() * 2 - 1) * R, dy: (rng() * 2 - 1) * R });
    },
  },
  {
    id: 'quitter',
    name: 'Quitter',
    description: 'Places 3 coins with a small lean, then cashes out.',
    create: () => (state) => {
      if (state.coinsOnTable >= state.stacks.length + 3) return CASH;
      const { stack, dir } = pickStack(state);
      return place(stack, { dx: dir.x * 10, dy: dir.y * 10 });
    },
  },
  {
    id: 'quality-reader',
    name: 'Quality Reader',
    description: 'Reads the volume. Safe margin shrinks and ambition grows with coin quality.',
    create: () => {
      let inner: Decider | null = null;
      return (state) => {
        if (!inner) {
          const q = state.quality;
          inner = harmonicBot({
            base: 2 + Math.round(6 * q),
            run: 6 + Math.round(8 * q),
            factor: 0.8 + 0.15 * q,
            safetyMm: 5 - 4 * q,
            giveUpCoins: 30 + Math.round(30 * q),
          });
        }
        return inner(state);
      };
    },
  },
];

export function getArchetype(id: string): BotArchetype {
  const a = ARCHETYPES.find((x) => x.id === id);
  if (!a) throw new Error(`unknown archetype ${id}`);
  return a;
}

export type { Mode, RoundState };

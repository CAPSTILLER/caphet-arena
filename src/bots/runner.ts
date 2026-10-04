import { cashOut, createRound, placeCoin, toRecord } from '../engine.js';
import { makeRng, type Seed } from '../prng.js';
import type { Mode, RoundRecord, RoundState } from '../types.js';
import { getArchetype } from './archetypes.js';
import type { BotArchetype } from './types.js';

export interface HouseRoundOptions {
  mode: Mode;
  seed: Seed;
  volumeUsd: number;
  archetype: BotArchetype | string;
  /** Seed for the bot's own choices. Defaults to the round seed with a suffix. */
  botSeed?: Seed;
  /** Stop (cash out) after this many placed coins. Used by the demo to keep every round short. */
  maxPlacements?: number;
}

/**
 * Play one whole round with a house bot. The bot only uses the public engine API
 * (createRound, placeCoin, cashOut) exactly like an external agent would.
 * Same options always produce the same round.
 */
export function playHouseRound(opts: HouseRoundOptions): { state: RoundState; record: RoundRecord } {
  const arche = typeof opts.archetype === 'string' ? getArchetype(opts.archetype) : opts.archetype;
  const rng = makeRng(opts.botSeed ?? `bot:${String(opts.seed)}:${arche.id}`);
  const decide = arche.create(rng, opts.mode);
  let state = createRound(opts.mode, opts.seed, opts.volumeUsd);
  let placed = 0;
  for (let guard = 0; state.status === 'active' && guard < 1000; guard++) {
    let action = decide(state);
    if (action.type === 'place' && opts.maxPlacements !== undefined && placed >= opts.maxPlacements) action = { type: 'cashout' };
    if (action.type === 'place') placed++;
    state = action.type === 'cashout' ? cashOut(state) : placeCoin(state, { dx: action.dx, dy: action.dy }, action.stack);
  }
  return { state, record: toRecord(state) };
}

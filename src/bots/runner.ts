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
  for (let guard = 0; state.status === 'active' && guard < 1000; guard++) {
    const action = decide(state);
    state = action.type === 'cashout' ? cashOut(state) : placeCoin(state, { dx: action.dx, dy: action.dy }, action.stack);
  }
  return { state, record: toRecord(state) };
}

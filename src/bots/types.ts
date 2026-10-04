import type { Mode, RoundState } from '../types.js';

export type BotAction = { type: 'place'; stack: number; dx: number; dy: number } | { type: 'cashout' };

/** One decision per call. It only sees the public RoundState, same as an external agent. */
export type Decider = (state: RoundState) => BotAction;

export interface BotArchetype {
  id: string;
  name: string;
  description: string;
  /** Build a fresh decider for one round. `rng` is the bot's own random stream (not the engine's). */
  create(rng: () => number, mode: Mode): Decider;
}

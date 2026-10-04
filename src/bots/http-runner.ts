import { createHash } from 'node:crypto';
import type { Mode, RoundState } from '../types.js';
import { getArchetype } from './archetypes.js';
import type { BotAction } from './types.js';

export interface HttpRunOptions {
  baseUrl: string;
  mode: Mode;
  archetype: string;
  wallet: string;
  botName?: string;
  /** Sent as x-house-secret so the server flags the bot as house. */
  houseSecret?: string;
  fetchFn?: typeof fetch;
  /** Seed for the bot's own choices (not the game's randomness). */
  botSeed?: string;
}

export interface HttpRunResult {
  roundId: string;
  mode: Mode;
  archetype: string;
  status: string;
  score: number;
  rawScore: number;
  coinsOnTable: number;
  ante: number;
  payout: number;
  vaultToTreasury: number;
  bestScoreAfter: number;
  moves: number;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(`${status} ${code}: ${message}`);
  }
}

/** Deterministic fake address for a house bot. */
export function houseWallet(archetype: string): string {
  return `0x${createHash('sha256').update(`house:${archetype}`).digest('hex').slice(0, 40)}`;
}

/**
 * Play one whole round of a house archetype through the public HTTP API only.
 * The bot sees exactly what an outside agent sees (the redacted state in each reply).
 */
export async function playHouseRoundHttp(o: HttpRunOptions): Promise<HttpRunResult> {
  const f = o.fetchFn ?? fetch;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (o.houseSecret) headers['x-house-secret'] = o.houseSecret;
  const call = async (path: string, body: unknown, key?: string): Promise<Record<string, any>> => {
    const res = await f(`${o.baseUrl}${path}`, {
      method: 'POST',
      headers: key ? { ...headers, authorization: `Bearer ${key}` } : headers,
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as Record<string, any>;
    if (!res.ok) throw new HttpError(res.status, json.error?.code ?? 'error', json.error?.message ?? res.statusText);
    return json;
  };

  let rng = 0;
  const seedStr = o.botSeed ?? `${o.archetype}:${Date.now()}:${Math.random()}`;
  for (let i = 0; i < seedStr.length; i++) rng = (Math.imul(rng, 31) + seedStr.charCodeAt(i)) >>> 0;
  const botRng = (): number => {
    rng = (rng + 0x6d2b79f5) >>> 0;
    let t = rng;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const join = await call('/join', { wallet: o.wallet, mode: o.mode, botName: o.botName ?? getArchetype(o.archetype).name });
  const key = join.key as string;
  let state = join.state as RoundState;
  const decide = getArchetype(o.archetype).create(botRng, o.mode);
  let last: Record<string, any> = join;
  let moves = 0;
  for (let guard = 0; state.status === 'active' && guard < 400; guard++) {
    const action: BotAction = decide(state);
    last = action.type === 'cashout' ? await call('/cashout', {}, key) : await call('/place', { dx: action.dx, dy: action.dy, stack: action.stack }, key);
    state = last.state as RoundState;
    moves++;
  }
  const ledger = last.ledger ?? null;
  return {
    roundId: join.roundId,
    mode: o.mode,
    archetype: o.archetype,
    status: state.status,
    score: state.score,
    rawScore: state.rawScore,
    coinsOnTable: state.coinsOnTable,
    ante: join.ante,
    payout: ledger?.payout ?? 0,
    vaultToTreasury: ledger?.vaultToTreasury ?? 0,
    bestScoreAfter: ledger?.newHighScore ?? join.wallet.bestScore,
    moves,
  };
}

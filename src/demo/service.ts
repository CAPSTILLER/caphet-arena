import { replay } from '../engine.js';
import { qualityFromVolume } from '../quality.js';
import type { Mode } from '../types.js';
import { ApiError } from '../server/errors.js';
import type { Store } from '../server/store/types.js';
import type { VolumeProvider } from '../server/volume.js';
import {
  DemoPlan,
  MAX_START_DELAY_MS,
  MAX_PLACEMENTS,
  MODES,
  PLAY_WINDOW_MS,
  SEATS_PER_MODE,
  SLOT_MS,
  botLabel,
  demoRoundId,
  parseDemoId,
  planFromId,
  seatFromIndex,
  archetypeIndexFor,
} from './plan.js';
import { ARCHETYPES } from '../bots/archetypes.js';

/** Volumes the viewer can pick besides "live" (what-if views of better or worse coins). */
export const VOLUME_CHOICES = [500, 5000, 30000, 100000] as const;
const BOARD_KEEP = 25;
const LOCK_MS = 15_000;
const MAX_FUTURE_SLOTS = 30;
const MAX_PAST_SLOTS = 5;

export interface BoardEntry {
  botName: string;
  archetype: string;
  house: true;
  mode: Mode;
  seat: number;
  score: number;
  rawScore: number;
  roundId: string;
  slot: number;
}

export interface DemoState {
  mode: Mode;
  vol: string;
  /** Last slot that was counted. */
  lastSlot: number;
  roundsFinished: number;
  falls: number;
  cashedOut: number;
  connected: number;
  coinsStacked: number;
  /** Totals of the last counted slot only. */
  lastSlotStats: { slot: number; falls: number; cashedOut: number; connected: number; avgScore: number; best: number };
  board: BoardEntry[];
  updatedAt: number;
}

export class DemoService {
  constructor(
    private store: Store,
    private volume: VolumeProvider,
    private now: () => number = Date.now,
  ) {}

  currentSlot(): number {
    return Math.floor(this.now() / SLOT_MS);
  }

  /** 'live' or one of VOLUME_CHOICES. */
  private async resolveVolume(vol: string): Promise<{ key: string; volumeUsd: number; live: boolean; source: string }> {
    if (vol === 'live') {
      const r = await this.volume.get();
      return { key: 'live', volumeUsd: Math.max(0, Math.round(r.volumeUsd)), live: true, source: r.source };
    }
    const n = Number(vol);
    if (!(VOLUME_CHOICES as readonly number[]).includes(n)) {
      throw new ApiError(400, 'bad_volume', `vol must be live or one of ${VOLUME_CHOICES.join(', ')}.`);
    }
    return { key: String(n), volumeUsd: n, live: false, source: 'what-if' };
  }

  async config(): Promise<Record<string, unknown>> {
    const live = await this.volume.get();
    return {
      demoMode: true,
      note: 'Watch-only demo. Every seat is always playing a house bot with play coins. Rounds are real engine rounds and replay exactly from their id.',
      slotMs: SLOT_MS,
      playWindowMs: PLAY_WINDOW_MS,
      maxStartDelayMs: MAX_START_DELAY_MS,
      maxPlacements: MAX_PLACEMENTS,
      modes: MODES,
      arenas: 10,
      subArenas: 10,
      tablesPerSubArena: 10,
      seatsPerMode: SEATS_PER_MODE,
      volumeChoices: ['live', ...VOLUME_CHOICES],
      live: { volumeUsd: Math.round(live.volumeUsd), quality: qualityFromVolume(live.volumeUsd), source: live.source, priceUsd: live.priceUsd, liquidityUsd: live.liquidityUsd },
      archetypes: ARCHETYPES.map((a) => ({ id: a.id, name: a.name, description: a.description })),
      serverNow: this.now(),
    };
  }

  /** The 10 tables of one sub-arena for one slot, with every move, ready for the browser to replay. */
  async tables(mode: Mode, arena: number, sub: number, slot: number | null, vol: string): Promise<Record<string, unknown>> {
    const cur = this.currentSlot();
    const s = slot ?? cur;
    if (!Number.isInteger(s) || s < cur - MAX_PAST_SLOTS || s > cur + MAX_FUTURE_SLOTS) {
      throw new ApiError(400, 'bad_slot', `slot must be between ${cur - MAX_PAST_SLOTS} and ${cur + MAX_FUTURE_SLOTS} (now is ${cur}).`);
    }
    const v = await this.resolveVolume(vol);
    const base = arena * 100 + sub * 10;
    const plans: DemoPlan[] = [];
    for (let t = 0; t < 10; t++) plans.push(planFromId(demoRoundId(mode, base + t, s, v.volumeUsd))!);
    return {
      mode,
      arena,
      subArena: sub,
      slot: s,
      slotStartMs: s * SLOT_MS,
      slotMs: SLOT_MS,
      volumeUsd: v.volumeUsd,
      quality: qualityFromVolume(v.volumeUsd),
      volumeSource: v.source,
      serverNow: this.now(),
      tables: plans,
    };
  }

  private overviewMemo = new Map<string, Record<string, unknown>>();

  /**
   * A compact picture of all 1000 seats for one minute: when each table starts, how fast it plays, and how it ends.
   * The page uses this to colour the ring of arenas and sub-arenas. Table close-ups still come from /demo/tables and
   * are replayed exactly by the browser; this list is only for the overview colours.
   * Per seat: [startDelayMs, stepMs, moves, end, score, coinsOnTable] where end is 1 fell, 2 cashed out, 3 stacks connected.
   */
  async overview(mode: Mode, slot: number | null, vol: string): Promise<Record<string, unknown>> {
    const cur = this.currentSlot();
    const s = slot ?? cur;
    if (!Number.isInteger(s) || s < cur - MAX_PAST_SLOTS || s > cur + MAX_FUTURE_SLOTS) {
      throw new ApiError(400, 'bad_slot', `slot must be between ${cur - MAX_PAST_SLOTS} and ${cur + MAX_FUTURE_SLOTS} (now is ${cur}).`);
    }
    const v = await this.resolveVolume(vol);
    const memoKey = `${mode}|${s}|${v.volumeUsd}`;
    let body = this.overviewMemo.get(memoKey);
    if (!body) {
      const seats: number[][] = [];
      for (let seat = 0; seat < SEATS_PER_MODE; seat++) {
        const p = planFromId(demoRoundId(mode, seat, s, v.volumeUsd))!;
        const end = p.result.status === 'fell' ? 1 : p.result.status === 'touched' ? 3 : 2;
        seats.push([p.startDelayMs, p.stepMs, p.moves.length, end, p.result.score, p.result.coinsOnTable]);
      }
      body = { mode, slot: s, slotStartMs: s * SLOT_MS, slotMs: SLOT_MS, volumeUsd: v.volumeUsd, quality: qualityFromVolume(v.volumeUsd), volumeSource: v.source, seats };
      this.overviewMemo.set(memoKey, body);
      if (this.overviewMemo.size > 6) this.overviewMemo.delete(this.overviewMemo.keys().next().value!);
    }
    return { ...body, serverNow: this.now() };
  }

  /** One round by id, with proof that it replays to the stated result. */
  roundView(id: string): Record<string, unknown> {
    const p = parseDemoId(id);
    if (!p) throw new ApiError(404, 'not_found', 'No such demo round.');
    const plan = planFromId(id)!;
    const r = replay(plan.seed, plan.mode, plan.volumeUsd, plan.moves);
    const verified =
      r.ok && r.state.status === plan.result.status && r.state.score === plan.result.score && r.state.rawScore === plan.result.rawScore && r.state.coinsOnTable === plan.result.coinsOnTable;
    return { ...plan, demo: true, ended: true, verified, slotStartMs: plan.slot * SLOT_MS, note: 'Demo round: house bot, play coins. The seed is public because nobody can play this round.' };
  }

  // -------------------------------------------------------------------------
  // leaderboard and totals: "tick on request", no cron
  // -------------------------------------------------------------------------

  /**
   * Counts the most recent finished slot (all 1000 seats of the mode) the first time anybody asks after it ended.
   * Skipped slots (nobody was watching) are not counted. The result is stored, so later requests are cheap.
   */
  async summary(mode: Mode, vol: string): Promise<Record<string, unknown>> {
    const v = await this.resolveVolume(vol);
    const key = `demo/state/${mode}-${v.key}`;
    const target = this.currentSlot() - 1;
    let st = await this.store.get<DemoState>(key);
    let updating = false;
    if (!st || st.lastSlot < target) {
      const lockKey = `demo/lock/${mode}-${v.key}`;
      const lock = await this.store.get<{ slot: number; at: number }>(lockKey);
      const busy = lock && lock.slot === target && this.now() - lock.at < LOCK_MS;
      if (busy && st) updating = true;
      else {
        await this.store.put(lockKey, { slot: target, at: this.now() });
        st = this.countSlot(mode, v.key, v.volumeUsd, target, st);
        await this.store.put(key, st);
      }
    }
    const live = await this.volume.get();
    return {
      volumeUsd: v.volumeUsd,
      quality: qualityFromVolume(v.volumeUsd),
      liveVolumeUsd: Math.round(live.volumeUsd),
      botsPlaying: SEATS_PER_MODE,
      tablesLive: SEATS_PER_MODE,
      updating,
      ...st!,
      leaderboard: st!.board,
      serverNow: this.now(),
    };
  }

  private countSlot(mode: Mode, volKey: string, volumeUsd: number, slot: number, prev: DemoState | null): DemoState {
    let falls = 0;
    let cashed = 0;
    let connected = 0;
    let coins = 0;
    let scoreSum = 0;
    let best = 0;
    const entries: BoardEntry[] = [];
    for (let seat = 0; seat < SEATS_PER_MODE; seat++) {
      const id = demoRoundId(mode, seat, slot, volumeUsd);
      const plan = planFromId(id)!;
      const r = plan.result;
      if (r.status === 'fell') falls++;
      else if (r.status === 'touched') connected++;
      else cashed++;
      coins += r.coinsOnTable;
      scoreSum += r.score;
      if (r.score > best) best = r.score;
      if (r.score > 0) entries.push({ botName: plan.botName, archetype: plan.archetype, house: true, mode, seat, score: r.score, rawScore: r.rawScore, roundId: id, slot });
    }
    entries.sort((a, b) => b.score - a.score || a.seat - b.seat);
    // one line per bot (seat), keep the better round
    const bySeat = new Map<number, BoardEntry>();
    for (const e of [...(prev?.board ?? []), ...entries.slice(0, BOARD_KEEP)]) {
      const old = bySeat.get(e.seat);
      if (!old || e.score > old.score) bySeat.set(e.seat, e);
    }
    const board = [...bySeat.values()].sort((a, b) => b.score - a.score || a.seat - b.seat).slice(0, BOARD_KEEP);
    return {
      mode,
      vol: volKey,
      lastSlot: slot,
      roundsFinished: (prev?.roundsFinished ?? 0) + SEATS_PER_MODE,
      falls: (prev?.falls ?? 0) + falls,
      cashedOut: (prev?.cashedOut ?? 0) + cashed,
      connected: (prev?.connected ?? 0) + connected,
      coinsStacked: (prev?.coinsStacked ?? 0) + coins,
      lastSlotStats: { slot, falls, cashedOut: cashed, connected, avgScore: Math.round((scoreSum / SEATS_PER_MODE) * 10) / 10, best },
      board,
      updatedAt: this.now(),
    };
  }
}

export { seatFromIndex, botLabel, archetypeIndexFor };

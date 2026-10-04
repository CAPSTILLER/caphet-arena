import { randomBytes, randomInt } from 'node:crypto';
import {
  EngineError,
  anteFor,
  canPlayMode,
  cashOut,
  createRound,
  placeCoin,
  replay,
  settleRound,
  type Mode,
  type Move,
  type RoundState,
} from '../index.js';
import { hashKey, newApiKey, openSecret, sealSecret, sha256Hex } from './auth.js';
import type { ServerConfig } from './config.js';
import { buildChainRecord, type RoundRecorder } from '../chain/records.js';
import { ApiError } from './errors.js';
import type { Store } from './store/types.js';
import type { GameEvent, LeaderboardEntry, NewEvent, RoundDoc, Seat, VaultDoc, WalletDoc } from './types.js';
import type { VolumeProvider } from './volume.js';

export interface ServiceDeps {
  store: Store;
  config: ServerConfig;
  volume: VolumeProvider;
  now?: () => number;
  /** Random hex string of n bytes. Injectable for tests. */
  randomHex?: (bytes: number) => string;
  randomInt?: (max: number) => number;
  /** Optional onchain recorder (src/chain/records.ts). Null/undefined means off. */
  recorder?: RoundRecorder | null;
}

const MODES: Mode[] = ['single', 'twin', 'triple'];
const pad3 = (n: number): string => String(n).padStart(3, '0');
const EVENTS_KEEP = 500;
const LEADERBOARD_KEEP = 200;

export function seatFromIndex(index: number): Seat {
  return { index, arena: Math.floor(index / 100), subArena: Math.floor(index / 10) % 10, table: index % 10, spot: 0 };
}

/** The public face of a state: never the seed or the internal random state (they would reveal the hidden hand-shake noise). */
export function redact(state: RoundState): RoundState {
  return { ...state, seed: '', rng: 0 };
}

export class GameService {
  private locks = new Map<string, Promise<unknown>>();
  readonly now: () => number;
  private randHex: (n: number) => string;
  private randInt: (max: number) => number;

  constructor(private d: ServiceDeps) {
    this.now = d.now ?? Date.now;
    this.randHex = d.randomHex ?? ((n) => randomBytes(n).toString('hex'));
    this.randInt = d.randomInt ?? ((max) => randomInt(max));
  }

  private get store(): Store {
    return this.d.store;
  }
  private get cfg(): ServerConfig {
    return this.d.config;
  }

  /** Run fn after every earlier fn with the same key finished (in this process). */
  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.locks.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  // -------------------------------------------------------------------------
  // documents
  // -------------------------------------------------------------------------

  private async getWallet(addr: string): Promise<WalletDoc> {
    return (
      (await this.store.get<WalletDoc>(`wallets/${addr}`)) ?? {
        wallet: addr,
        bestScore: 0,
        bestByMode: {},
        balance: this.cfg.startingBalance,
        plays: 0,
        activeRound: null,
        house: false,
        createdAt: this.now(),
      }
    );
  }
  private async getVault(): Promise<VaultDoc> {
    return (
      (await this.store.get<VaultDoc>('vault')) ?? {
        balance: this.cfg.vaultStart,
        treasury: 0,
        totals: { anteIn: 0, paidOut: 0, feesToTreasury: 0, rounds: 0, houseTopUps: 0 },
      }
    );
  }

  private seedOf(doc: RoundDoc): string {
    return openSecret(this.cfg.serverSecret, doc.seedSealed);
  }

  /** Rebuild the state from seed + volume + moves. Throws a 500 if the stored summary disagrees (integrity check). */
  private stateOf(doc: RoundDoc): RoundState {
    const r = replay(this.seedOf(doc), doc.mode, doc.volumeUsd, doc.moves);
    if (!r.ok) throw new ApiError(500, 'integrity_error', `stored moves do not replay: ${r.error}`);
    const s = r.state;
    const sum = doc.summary;
    if (s.status !== sum.status || s.score !== sum.score || s.rawScore !== sum.rawScore || s.coinsOnTable !== sum.coinsOnTable) {
      throw new ApiError(500, 'integrity_error', 'stored summary does not match the replayed round');
    }
    return s;
  }

  async getRoundDoc(id: string): Promise<RoundDoc> {
    const doc = await this.store.get<RoundDoc>(`rounds/${id}`);
    if (!doc) throw new ApiError(404, 'round_not_found', 'No such round');
    return doc;
  }

  // -------------------------------------------------------------------------
  // events
  // -------------------------------------------------------------------------

  private async pushEvent(e: NewEvent): Promise<void> {
    await this.withLock('events', async () => {
      const doc = (await this.store.get<{ seq: number; items: GameEvent[] }>('events/recent')) ?? { seq: 0, items: [] };
      doc.seq += 1;
      doc.items.push({ ...e, seq: doc.seq, t: this.now() } as GameEvent);
      if (doc.items.length > EVENTS_KEEP) doc.items.splice(0, doc.items.length - EVENTS_KEEP);
      await this.store.put('events/recent', doc);
    });
  }

  async latestSeq(): Promise<number> {
    return ((await this.store.get<{ seq: number }>('events/recent')) ?? { seq: 0 }).seq;
  }

  async eventsSince(since: number, limit = 100): Promise<{ events: GameEvent[]; next: number }> {
    const doc = (await this.store.get<{ seq: number; items: GameEvent[] }>('events/recent')) ?? { seq: 0, items: [] };
    const events = doc.items.filter((e) => e.seq > since).slice(0, limit);
    return { events, next: events.length ? events[events.length - 1]!.seq : Math.max(since, 0) };
  }

  // -------------------------------------------------------------------------
  // join
  // -------------------------------------------------------------------------

  async join(req: { wallet: string; mode: Mode; botName: string; house: boolean }): Promise<Record<string, unknown>> {
    // joinlock stops the same wallet from starting two rounds at once
    return this.withLock(`join:${req.wallet}`, async () => {
      let w = await this.getWallet(req.wallet);

      // one active round per wallet
      if (w.activeRound) {
        const existing = await this.store.get<RoundDoc>(`rounds/${w.activeRound}`);
        if (existing && existing.endedAt === null) {
          if (this.now() - existing.lastActiveAt > this.cfg.idleExpiryMs) {
            await this.closeIdle(existing);
            w = await this.getWallet(req.wallet);
          } else {
            throw new ApiError(409, 'wallet_has_active_round', 'This wallet already has a round in play. Finish it (cash out or fall) first.', { roundId: existing.id });
          }
        }
      }

      if (!canPlayMode(w.bestScore, req.mode)) {
        throw new ApiError(403, 'mode_locked', `A wallet with no registered best score may only play single stack. Play single and finish with a score above 0 first (asked for ${req.mode}).`);
      }
      const ante = anteFor(w.bestScore);
      if (!req.house && !w.house && w.balance < ante) {
        throw new ApiError(402, 'insufficient_balance', `Ante is ${ante} play coins but the wallet has ${w.balance}.`, { ante, balance: w.balance });
      }

      const reading = await this.d.volume.get();
      const seed = this.randHex(16);
      const roundId = `r_${this.randHex(6)}`;
      const seat = await this.claimSeat(req.mode, roundId);

      let state: RoundState;
      let wallet: WalletDoc;
      try {
        state = createRound(req.mode, seed, reading.volumeUsd);
        // take the ante and mark the round active, under the wallet lock so a settling round cannot be overwritten
        wallet = await this.withLock(`wallet:${req.wallet}`, async () => {
          const fresh = await this.getWallet(req.wallet);
          if (req.house) fresh.house = true;
          if (fresh.balance < ante) {
            if (!fresh.house) throw new ApiError(402, 'insufficient_balance', `Ante is ${ante} play coins but the wallet has ${fresh.balance}.`, { ante, balance: fresh.balance });
            // house wallets are funded by the operator
            const topUp = ante + this.cfg.startingBalance - fresh.balance;
            fresh.balance += topUp;
            await this.withLock('vault', async () => {
              const v = await this.getVault();
              v.totals.houseTopUps += topUp;
              await this.store.put('vault', v);
            });
          }
          fresh.balance -= ante;
          fresh.activeRound = roundId;
          await this.store.put(`wallets/${req.wallet}`, fresh);
          return fresh;
        });
      } catch (e) {
        await this.releaseSeat(req.mode, seat.index, roundId);
        throw e;
      }

      const key = newApiKey();
      const t = this.now();
      const doc: RoundDoc = {
        id: roundId,
        wallet: req.wallet,
        botName: req.botName,
        house: wallet.house,
        mode: req.mode,
        seedSealed: sealSecret(this.cfg.serverSecret, seed),
        seedCommit: sha256Hex(`${roundId}:${seed}`),
        volumeUsd: reading.volumeUsd,
        volumeSource: reading.source,
        quality: state.quality,
        moves: [],
        seat,
        ante,
        bestAtStart: w.bestScore,
        startedAt: t,
        lastActiveAt: t,
        endedAt: null,
        summary: { status: state.status, score: state.score, rawScore: state.rawScore, coinsOnTable: state.coinsOnTable },
        ledger: null,
        keyHash: hashKey(key),
      };
      await this.store.put(`rounds/${roundId}`, doc);
      await this.store.put(`keys/${doc.keyHash}`, { roundId, wallet: req.wallet });
      if (ante > 0) {
        await this.withLock('vault', async () => {
          const v = await this.getVault();
          v.balance += ante;
          v.totals.anteIn += ante;
          await this.store.put('vault', v);
        });
      }
      await this.pushEvent({ type: 'join', roundId, mode: req.mode, wallet: req.wallet, botName: req.botName, house: wallet.house, seat, ante, volumeUsd: reading.volumeUsd, quality: state.quality, homes: state.homes });

      return {
        roundId,
        key,
        mode: req.mode,
        seat,
        ante,
        volumeUsd: reading.volumeUsd,
        volumeSource: reading.source,
        quality: state.quality,
        seedCommit: doc.seedCommit,
        seedNote: 'The seed is revealed in GET /replay/:round once the round has ended. seedCommit = sha256("<roundId>:<seed>") lets you check it.',
        wallet: { address: req.wallet, bestScore: wallet.bestScore, balance: wallet.balance, house: wallet.house },
        state: redact(state),
      };
    });
  }

  private async claimSeat(mode: Mode, roundId: string): Promise<Seat> {
    const n = this.cfg.seatsPerMode;
    const start = this.randInt(n);
    for (let i = 0; i < n; i++) {
      const idx = (start + i) % n;
      const key = `seats/${mode}/${pad3(idx)}`;
      if (await this.store.putIfAbsent(key, { roundId, claimedAt: this.now() })) return seatFromIndex(idx);
      // occupied: free it if its round was abandoned
      const occ = await this.store.get<{ roundId: string; claimedAt?: number }>(key);
      if (!occ) {
        i--; // vanished between calls, retry same seat once
        continue;
      }
      const other = await this.store.get<RoundDoc>(`rounds/${occ.roundId}`);
      // A claim whose round doc is not written yet belongs to a join in flight: leave it alone for a minute.
      const inFlight = !other && this.now() - (occ.claimedAt ?? 0) < 60_000;
      if (inFlight) continue;
      if (!other || other.endedAt !== null) {
        await this.store.delete(key);
        if (await this.store.putIfAbsent(key, { roundId, claimedAt: this.now() })) return seatFromIndex(idx);
      } else if (this.now() - other.lastActiveAt > this.cfg.idleExpiryMs) {
        await this.closeIdle(other);
        if (await this.store.putIfAbsent(key, { roundId, claimedAt: this.now() })) return seatFromIndex(idx);
      }
    }
    throw new ApiError(503, 'arena_full', `All ${n} ${mode} seats are taken. Try again in a moment.`, {}, 5);
  }

  private async releaseSeat(mode: Mode, index: number, roundId: string): Promise<void> {
    const key = `seats/${mode}/${pad3(index)}`;
    const occ = await this.store.get<{ roundId: string }>(key);
    if (occ && occ.roundId === roundId) await this.store.delete(key);
  }

  // -------------------------------------------------------------------------
  // play
  // -------------------------------------------------------------------------

  async authenticate(key: string | null): Promise<RoundDoc> {
    if (!key) throw new ApiError(401, 'missing_key', 'Send your API key as "Authorization: Bearer <key>" or "x-api-key".');
    const rec = await this.store.get<{ roundId: string }>(`keys/${hashKey(key)}`);
    if (!rec) throw new ApiError(401, 'bad_key', 'Unknown API key.');
    return this.getRoundDoc(rec.roundId);
  }

  async place(roundId: string, move: { dx: number; dy: number; stack: number }): Promise<Record<string, unknown>> {
    return this.withLock(`round:${roundId}`, async () => {
      const doc = await this.getRoundDoc(roundId);
      if (doc.endedAt !== null) throw new ApiError(409, 'round_over', `Round already ended (${doc.summary.status}).`, { status: doc.summary.status });
      if (this.now() - doc.lastActiveAt > this.cfg.idleExpiryMs) {
        await this.closeIdle(doc);
        throw new ApiError(409, 'round_expired', 'Round was idle too long and was closed as a cash out.');
      }
      const before = this.stateOf(doc);
      let after: RoundState;
      try {
        after = placeCoin(before, { dx: move.dx, dy: move.dy }, move.stack);
      } catch (e) {
        if (e instanceof EngineError) throw new ApiError(400, 'bad_move', e.message);
        throw e;
      }
      const stored: Move = after.moves[after.moves.length - 1]!;
      doc.moves.push(stored);
      this.verifyAgainstReplay(doc, after);
      doc.lastActiveAt = this.now();
      doc.summary = { status: after.status, score: after.score, rawScore: after.rawScore, coinsOnTable: after.coinsOnTable };
      const placed = after.stacks[move.stack]![after.stacks[move.stack]!.length - 1]!;
      await this.pushEvent({ type: 'place', roundId, mode: doc.mode, stack: move.stack, layer: after.stacks[move.stack]!.length - 1, x: placed.x, y: placed.y, status: after.status, coinsOnTable: after.coinsOnTable, score: after.score });
      let ledger = null;
      if (after.status !== 'active') ledger = await this.settle(doc, after);
      else await this.store.put(`rounds/${roundId}`, doc);
      return this.view(doc, after, { ledger, lastMove: stored });
    });
  }

  async cashOut(roundId: string): Promise<Record<string, unknown>> {
    return this.withLock(`round:${roundId}`, async () => {
      const doc = await this.getRoundDoc(roundId);
      if (doc.endedAt !== null) throw new ApiError(409, 'round_over', `Round already ended (${doc.summary.status}).`, { status: doc.summary.status });
      const before = this.stateOf(doc);
      const after = cashOut(before);
      doc.moves.push(after.moves[after.moves.length - 1]!);
      this.verifyAgainstReplay(doc, after);
      doc.summary = { status: after.status, score: after.score, rawScore: after.rawScore, coinsOnTable: after.coinsOnTable };
      const ledger = await this.settle(doc, after);
      return this.view(doc, after, { ledger });
    });
  }

  /** Server side verification: an independent full replay of seed + volume + moves must equal the state we just computed. */
  private verifyAgainstReplay(doc: RoundDoc, expected: RoundState): void {
    const r = replay(this.seedOf(doc), doc.mode, doc.volumeUsd, doc.moves);
    if (!r.ok || JSON.stringify(r.state) !== JSON.stringify(expected)) {
      throw new ApiError(500, 'integrity_error', 'replay verification failed; move rejected');
    }
  }

  /** Close an abandoned round as an automatic cash out. */
  private async closeIdle(doc: RoundDoc): Promise<void> {
    if (doc.endedAt !== null) return;
    await this.withLock(`round:${doc.id}`, async () => {
      const fresh = await this.getRoundDoc(doc.id);
      if (fresh.endedAt !== null) return;
      const after = cashOut(this.stateOf(fresh));
      fresh.moves.push(after.moves[after.moves.length - 1]!);
      this.verifyAgainstReplay(fresh, after);
      fresh.summary = { status: after.status, score: after.score, rawScore: after.rawScore, coinsOnTable: after.coinsOnTable };
      await this.settle(fresh, after);
    });
  }

  /** Apply the ledger: wallet balance, best score, vault, treasury, seat, leaderboard, end event. */
  private async settle(doc: RoundDoc, state: RoundState) {
    const entry = settleRound(state, { highScore: doc.bestAtStart });
    // Independent check: the record we would publish must verify.
    doc.ledger = entry;
    doc.endedAt = this.now();
    if (this.wantsChain(doc)) doc.chain = { status: 'pending', attempts: 0 };
    await this.store.put(`rounds/${doc.id}`, doc);

    await this.withLock(`wallet:${doc.wallet}`, async () => {
      const w = await this.getWallet(doc.wallet);
      w.balance += entry.vaultToWallet;
      w.bestScore = Math.max(w.bestScore, entry.newHighScore);
      if (entry.recordedScore !== null) w.bestByMode[doc.mode] = Math.max(w.bestByMode[doc.mode] ?? 0, entry.recordedScore);
      w.plays += 1;
      if (w.activeRound === doc.id) w.activeRound = null;
      await this.store.put(`wallets/${doc.wallet}`, w);
    });
    await this.withLock('vault', async () => {
      const v = await this.getVault();
      v.balance -= entry.vaultToWallet + entry.vaultToTreasury;
      v.treasury += entry.vaultToTreasury;
      v.totals.paidOut += entry.vaultToWallet;
      v.totals.feesToTreasury += entry.vaultToTreasury;
      v.totals.rounds += 1;
      await this.store.put('vault', v);
    });
    await this.releaseSeat(doc.mode, doc.seat.index, doc.id);
    if (entry.recordedScore !== null) await this.updateLeaderboard(doc, entry.recordedScore, entry.rawScore);
    await this.pushEvent({
      type: 'end',
      roundId: doc.id,
      mode: doc.mode,
      outcome: entry.outcome,
      status: state.status,
      score: entry.score,
      rawScore: entry.rawScore,
      payout: entry.payout,
      ante: entry.stake,
      vaultToTreasury: entry.vaultToTreasury,
      newBestScore: entry.newHighScore,
    });
    if (doc.chain) await this.tryChain(doc, this.cfg.chainWaitMs);
    return entry;
  }

  // -------------------------------------------------------------------------
  // onchain records (optional)
  // -------------------------------------------------------------------------

  private wantsChain(doc: RoundDoc): boolean {
    return !!this.d.recorder && (!doc.house || this.cfg.chainRecordHouse);
  }

  chainInfo(): Record<string, unknown> {
    return this.d.recorder ? { enabled: true, ...this.d.recorder.info(), recordHouse: this.cfg.chainRecordHouse } : { enabled: false };
  }

  /** Send the record, wait at most waitMs. A slow or failed send stays pending/failed and is retried by flushChain. */
  private async tryChain(doc: RoundDoc, waitMs: number): Promise<void> {
    const rec = this.d.recorder;
    if (!rec || !doc.chain || doc.chain.status === 'recorded' || !doc.ledger) return;
    doc.chain.attempts += 1;
    const send = rec.record(buildChainRecord({ ...doc, ledger: doc.ledger }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((res) => (timer = setTimeout(() => res('timeout'), waitMs)));
    try {
      const r = await Promise.race([send, timeout]);
      if (r === 'timeout') {
        send.catch(() => undefined);
        return; // still pending: the transaction may land; flushChain checks isRecorded before sending again
      }
      doc.chain = { status: 'recorded', txHash: r.txHash, attempts: doc.chain.attempts };
    } catch (e) {
      doc.chain = { status: 'failed', error: (e instanceof Error ? e.message : String(e)).slice(0, 200), attempts: doc.chain.attempts };
    } finally {
      clearTimeout(timer);
    }
    await this.store.put(`rounds/${doc.id}`, doc);
  }

  /** Retry rounds whose record is pending or failed. Called from POST /admin/chain/flush (cron). */
  async flushChain(max = 25): Promise<{ attempted: number; recorded: number; failed: number }> {
    const out = { attempted: 0, recorded: 0, failed: 0 };
    if (!this.d.recorder) return out;
    for (const key of await this.store.list('rounds/')) {
      if (out.attempted >= max) break;
      const peek = await this.store.get<RoundDoc>(key);
      if (!peek?.chain || peek.chain.status === 'recorded' || peek.endedAt === null) continue;
      await this.withLock(`round:${peek.id}`, async () => {
        const doc = await this.getRoundDoc(peek.id);
        if (!doc.chain || doc.chain.status === 'recorded') return;
        out.attempted++;
        await this.tryChain(doc, 30_000);
        if ((doc as RoundDoc).chain?.status === 'recorded') out.recorded++;
        else out.failed++;
      });
    }
    return out;
  }

  private async updateLeaderboard(doc: RoundDoc, score: number, rawScore: number): Promise<void> {
    await this.withLock(`lb:${doc.mode}`, async () => {
      const key = `leaderboard/${doc.mode}`;
      const lb = (await this.store.get<{ entries: LeaderboardEntry[] }>(key)) ?? { entries: [] };
      const i = lb.entries.findIndex((e) => e.wallet === doc.wallet);
      const entry: LeaderboardEntry = { wallet: doc.wallet, botName: doc.botName, house: doc.house, mode: doc.mode, score, rawScore, roundId: doc.id, at: this.now() };
      if (i >= 0) {
        if (lb.entries[i]!.score >= score) return;
        lb.entries[i] = entry;
      } else lb.entries.push(entry);
      lb.entries.sort((a, b) => b.score - a.score || a.at - b.at);
      lb.entries.length = Math.min(lb.entries.length, LEADERBOARD_KEEP);
      await this.store.put(key, lb);
    });
  }

  // -------------------------------------------------------------------------
  // reads
  // -------------------------------------------------------------------------

  private view(doc: RoundDoc, state: RoundState, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      roundId: doc.id,
      mode: doc.mode,
      botName: doc.botName,
      house: doc.house,
      wallet: doc.wallet,
      seat: doc.seat,
      ante: doc.ante,
      volumeUsd: doc.volumeUsd,
      volumeSource: doc.volumeSource,
      quality: doc.quality,
      status: state.status,
      score: state.score,
      rawScore: state.rawScore,
      coinsOnTable: state.coinsOnTable,
      fallFeeIfFell: state.fallFee,
      startedAt: doc.startedAt,
      lastActiveAt: doc.lastActiveAt,
      endedAt: doc.endedAt,
      ledger: doc.ledger,
      state: redact(state),
      ...extra,
    };
  }

  async publicState(roundId: string): Promise<Record<string, unknown>> {
    const doc = await this.getRoundDoc(roundId);
    return this.view(doc, this.stateOf(doc));
  }

  async replayView(roundId: string): Promise<Record<string, unknown>> {
    const doc = await this.getRoundDoc(roundId);
    const state = this.stateOf(doc);
    const ended = doc.endedAt !== null;
    const base = {
      roundId: doc.id,
      mode: doc.mode,
      volumeUsd: doc.volumeUsd,
      quality: doc.quality,
      engineVersion: state.engineVersion,
      seedCommit: doc.seedCommit,
      moves: doc.moves,
      ended,
    };
    if (!ended) return { ...base, seed: null, note: 'The seed is withheld until the round ends so the hidden hand-shake noise cannot be pre-computed.' };
    const seed = this.seedOf(doc);
    const v = replay(seed, doc.mode, doc.volumeUsd, doc.moves);
    const verified = v.ok && v.state.status === doc.summary.status && v.state.score === doc.summary.score && v.state.rawScore === doc.summary.rawScore;
    return { ...base, seed, status: doc.summary.status, score: doc.summary.score, rawScore: doc.summary.rawScore, coinsOnTable: doc.summary.coinsOnTable, ledger: doc.ledger, chain: doc.chain ?? null, verified, seedMatchesCommit: sha256Hex(`${doc.id}:${seed}`) === doc.seedCommit };
  }

  async leaderboard(mode: Mode | null, limit: number): Promise<Record<string, unknown>> {
    const modes = mode ? [mode] : MODES;
    const out: Record<string, LeaderboardEntry[]> = {};
    for (const m of modes) {
      const lb = (await this.store.get<{ entries: LeaderboardEntry[] }>(`leaderboard/${m}`)) ?? { entries: [] };
      out[m] = lb.entries.slice(0, limit);
    }
    return { leaderboard: out, note: 'Best recorded score per wallet per mode. house=true marks the operator\'s house bots.' };
  }

  async stats(): Promise<Record<string, unknown>> {
    const seats: Record<string, { used: number; total: number }> = {};
    for (const m of MODES) seats[m] = { used: (await this.store.list(`seats/${m}/`)).length, total: this.cfg.seatsPerMode };
    const v = await this.getVault();
    return { seats, vault: v, now: this.now() };
  }

  async walletInfo(addr: string): Promise<WalletDoc> {
    return this.getWallet(addr);
  }
}

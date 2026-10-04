import { describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';
import { seatFromIndex } from '../src/server/service.js';
import { MemoryStore } from '../src/server/store/memory.js';
import { FixedVolumeProvider } from '../src/server/volume.js';
import type { Store } from '../src/server/store/types.js';

const addr = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;
const HOUSE = 'house-secret-for-tests';

function make(over: Record<string, unknown> = {}, volumeUsd = 100_000) {
  const clock = { t: 1_000_000 };
  const store: Store = new MemoryStore();
  const volume = new FixedVolumeProvider(volumeUsd);
  const { app, service, config } = createApp({
    store,
    volume,
    now: () => clock.t,
    config: { houseSecret: HOUSE, serverSecret: 'test-secret', ...over },
  });
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* text endpoint */
    }
    return { status: res.status, json, text, headers: res.headers };
  };
  const join = async (wallet: string, mode = 'single', headers: Record<string, string> = {}) =>
    call('POST', '/join', { wallet, mode, botName: 'TestBot' }, headers);
  const auth = (key: string) => ({ authorization: `Bearer ${key}` });
  const place = (key: string, dx: number, dy = 0, stack = 0) => call('POST', '/place', { dx, dy, stack }, auth(key));
  return { app, service, config, store, clock, volume, call, join, auth, place };
}

async function scoreSingle(s: ReturnType<typeof make>, wallet: string, dx = 20.4) {
  const j = await s.join(wallet);
  expect(j.status).toBe(200);
  await s.place(j.json.key, dx);
  const end = await s.call('POST', '/cashout', {}, s.auth(j.json.key));
  return { j, end };
}

describe('docs', () => {
  it('serves plain-language rules that match the engine numbers', async () => {
    const r = await make().call('GET', '/llms.txt');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/plain');
    expect(r.text.length).toBeGreaterThan(1500);
  });
  it('serves an OpenAPI document with every endpoint', async () => {
    const r = await make().call('GET', '/openapi.json');
    expect(r.json.openapi).toMatch(/^3\./);
    for (const p of ['/join', '/place', '/cashout', '/state/{round}', '/replay/{round}', '/leaderboard', '/events', '/volume', '/chain', '/auth/nonce', '/demo/tables', '/demo/overview', '/demo/summary', '/demo/round/{id}']) {
      expect(Object.keys(r.json.paths)).toContain(p);
    }
  });
});

describe('join', () => {
  it('validates input', async () => {
    const s = make();
    expect((await s.call('POST', '/join', { wallet: 'nope', mode: 'single' })).status).toBe(400);
    expect((await s.call('POST', '/join', { wallet: addr(1), mode: 'huge' })).status).toBe(400);
    expect((await s.call('POST', '/join', { wallet: addr(1), mode: 'single', botName: '<script>' })).status).toBe(400);
    expect((await s.call('POST', '/join', { wallet: addr(1), mode: 'single', pad: 'x'.repeat(5000) })).status).toBe(413);
    const bad = await s.app.request('/join', { method: 'POST', body: '{not json' });
    expect(bad.status).toBe(400);
  });

  it('returns seat, key, locked volume, ante and a redacted state, and never the seed', async () => {
    const s = make();
    const r = await s.join(addr(1));
    expect(r.status).toBe(200);
    const j = r.json;
    expect(j.roundId).toMatch(/^r_/);
    expect(j.key).toMatch(/^sk_/);
    expect(j.ante).toBe(0);
    expect(j.volumeUsd).toBe(100_000);
    expect(j.seedCommit).toMatch(/^[0-9a-f]{64}$/);
    expect(j.seat.spot).toBe(0);
    expect(j.seat.arena).toBeLessThan(10);
    expect(j.state.seed).toBe('');
    const rep = (await s.call('GET', `/replay/${j.roundId}`)).json;
    expect(rep.seed).toBeNull();
    const doc: any = await s.store.get(`rounds/${j.roundId}`);
    expect(JSON.stringify(doc)).not.toMatch(/"seed":"[0-9a-f]{16}/);
  });

  it('keeps first-play wallets to single stack', async () => {
    const s = make();
    for (const mode of ['twin', 'triple']) {
      const r = await s.join(addr(2), mode);
      expect(r.status).toBe(403);
    }
    expect((await s.join(addr(2), 'single')).status).toBe(200);
  });

  it('allows one active round per wallet', async () => {
    const s = make();
    const a = await s.join(addr(3));
    const b = await s.join(addr(3));
    expect(b.status).toBe(409);
    expect(JSON.stringify(b.json)).toContain(a.json.roundId);
  });

  it('locks the volume it read at round start', async () => {
    const s = make({}, 7000);
    const a = await s.join(addr(4));
    s.volume.volumeUsd = 90_000;
    const state = await s.call('GET', `/state/${a.json.roundId}`);
    expect(state.json.volumeUsd).toBe(7000);
  });
});

describe('play and settle (play coins)', () => {
  it('requires a valid key and a sane move', async () => {
    const s = make();
    const j = (await s.join(addr(5))).json;
    expect((await s.call('POST', '/place', { dx: 1, dy: 0 })).status).toBe(401);
    expect((await s.call('POST', '/place', { dx: 1, dy: 0 }, s.auth('sk_wrong'))).status).toBe(401);
    expect((await s.place(j.key, 1000)).status).toBe(400);
    expect((await s.place(j.key, 1, 0, 7)).status).toBe(400);
    expect((await s.place(j.key, 1, 0, 2)).status).toBe(400);
    const ok = await s.place(j.key, 5);
    expect(ok.status).toBe(200);
    expect(ok.json.status).toBe('active');
    expect((await s.call('POST', '/place', { dx: 1, dy: 0, stack: 0 }, { 'x-api-key': j.key })).status).toBe(200);
  });

  it('first-play fall moves no tokens and costs no fee; the seat is freed and the seed revealed', async () => {
    const s = make();
    const j = (await s.join(addr(6))).json;
    const r = await s.place(j.key, 60);
    expect(r.json.status).toBe('fell');
    expect(r.json.ledger).toMatchObject({ outcome: 'fell', stake: 0, payout: 0, vaultToTreasury: 0 });
    const w = (await s.call('GET', `/wallet/${addr(6)}`)).json;
    expect(w.balance).toBe(1000);
    expect(w.bestScore).toBe(0);
    const stats = (await s.call('GET', '/stats')).json;
    expect(JSON.stringify(stats.seats)).toContain('"used":0');
    const rep = (await s.call('GET', `/replay/${j.roundId}`)).json;
    expect(typeof rep.seed).toBe('string');
    expect(rep.verified).toBe(true);
    expect(rep.seedMatchesCommit).toBe(true);
    expect(rep.moves).toHaveLength(1);
    expect((await s.place(j.key, 1)).status).toBeGreaterThanOrEqual(400);
  });

  it('single cash out pays exactly the current score; best score and leaderboard update', async () => {
    const s = make();
    const { end } = await scoreSingle(s, addr(7));
    expect(end.json.status).toBe('cashed');
    expect(end.json.score).toBe(20);
    expect(end.json.ledger).toMatchObject({ stake: 0, payout: 20 });
    const w = (await s.call('GET', `/wallet/${addr(7)}`)).json;
    expect(w.bestScore).toBe(20);
    expect(w.balance).toBe(1020);
    const lb = (await s.call('GET', '/leaderboard?mode=single')).json.leaderboard.single;
    expect(lb[0]).toMatchObject({ wallet: addr(7), score: 20, house: false });
  });

  it('second play: ante is the best score, cash out below it is a net loss, best score stays', async () => {
    const s = make();
    await scoreSingle(s, addr(8), 20.4);
    const j = (await s.join(addr(8))).json;
    expect(j.ante).toBe(20);
    await s.place(j.key, 10.2);
    const end = await s.call('POST', '/cashout', {}, s.auth(j.key));
    expect(end.json.ledger).toMatchObject({ stake: 20, payout: 10 });
    const w = (await s.call('GET', `/wallet/${addr(8)}`)).json;
    expect(w.bestScore).toBe(20);
    expect(w.balance).toBe(1010);
  });

  it('twin: cash out returns the ante with no score; a fall keeps the ante and sends the fee to the treasury', async () => {
    const s = make();
    await scoreSingle(s, addr(9));
    const a = (await s.join(addr(9), 'twin')).json;
    expect(a.ante).toBe(20);
    await s.place(a.key, 3, 0, 0);
    const c = await s.call('POST', '/cashout', {}, s.auth(a.key));
    expect(c.json.ledger).toMatchObject({ stake: 20, payout: 20 });
    expect((await s.call('GET', `/wallet/${addr(9)}`)).json.balance).toBe(1020);
    const b = (await s.join(addr(9), 'twin')).json;
    const f = await s.place(b.key, 70, 0, 1);
    expect(f.json.status).toBe('fell');
    expect(f.json.ledger).toMatchObject({ stake: 20, payout: 0, vaultToTreasury: 1 });
    expect((await s.call('GET', `/wallet/${addr(9)}`)).json.balance).toBe(1000);
  });

  it('twin win through the API: stacks connect, ante returned, capped score recorded', async () => {
    const s = make();
    await scoreSingle(s, addr(10));
    const j = (await s.join(addr(10), 'twin')).json;
    // first coins sit 158.75 mm apart: lean each stack toward the other
    const steps = [10.5, 15.8, 31.7];
    for (const o of steps) await s.place(j.key, o, 0, 0);
    let last: any;
    for (const o of steps) last = await s.place(j.key, -o, 0, 1);
    expect(['touched', 'fell', 'active']).toContain(last.json.status);
    if (last.json.status === 'touched') {
      expect(last.json.ledger.payout).toBe(20);
      expect(last.json.score).toBeLessThanOrEqual(last.json.rawScore);
    }
  });

  it('rejects an ante the wallet cannot pay, but house wallets are topped up', async () => {
    const s = make({ startingBalance: 0 });
    await scoreSingle(s, addr(11));
    const j = (await s.join(addr(11))).json;
    await s.place(j.key, 60);
    const broke = await s.join(addr(11));
    expect(broke.status).toBe(402);
    await scoreSingle(s, addr(12));
    const h1 = (await s.join(addr(12), 'single', { 'x-house-secret': HOUSE })).json;
    await s.place(h1.key, 60);
    const h2 = await s.join(addr(12), 'single', { 'x-house-secret': HOUSE });
    expect(h2.status).toBe(200);
  });

  it('marks house bots on the leaderboard only when the house secret is sent', async () => {
    const s = make();
    await scoreSingle(s, addr(13));
    const j = (await s.join(addr(14), 'single', { 'x-house-secret': HOUSE })).json;
    await s.place(j.key, 25.4, 0);
    await s.call('POST', '/cashout', {}, { ...s.auth(j.key), 'x-house-secret': HOUSE });
    const lb = (await s.call('GET', '/leaderboard?mode=single')).json.leaderboard.single;
    expect(lb.find((e: any) => e.wallet === addr(14)).house).toBe(true);
    expect(lb.find((e: any) => e.wallet === addr(13)).house).toBe(false);
    const wrong = await s.join(addr(15), 'single', { 'x-house-secret': 'guess' });
    expect(wrong.json.wallet.house).toBe(false);
  });

  it('closes idle rounds as a cash out and frees the seat', async () => {
    const s = make({ idleExpiryMs: 60_000 });
    const a = (await s.join(addr(16))).json;
    await s.place(a.key, 20.4);
    s.clock.t += 120_000;
    const b = await s.join(addr(16));
    expect(b.status).toBe(200);
    const old = (await s.call('GET', `/state/${a.roundId}`)).json;
    expect(old.status).toBe('cashed');
    expect(old.ledger.payout).toBe(20);
  });
});

describe('seats', () => {
  it('maps a seat index to arena / subArena / table / spot', () => {
    expect(seatFromIndex(0)).toMatchObject({ arena: 0, subArena: 0, table: 0, spot: 0 });
    expect(seatFromIndex(123)).toMatchObject({ arena: 1, subArena: 2, table: 3, spot: 0 });
    expect(seatFromIndex(999)).toMatchObject({ arena: 9, subArena: 9, table: 9, spot: 0 });
  });
  it('gives every concurrent round its own seat', async () => {
    const s = make();
    const results = await Promise.all(Array.from({ length: 60 }, (_, i) => s.join(addr(100 + i), 'single', { 'x-house-secret': HOUSE })));
    const seen = new Set<number>();
    for (const r of results) {
      expect(r.status).toBe(200);
      seen.add(r.json.seat.index);
    }
    expect(seen.size).toBe(60);
  });
  it('says the arena is full when every seat is taken, and frees a seat when a round ends', async () => {
    const s = make({ seatsPerMode: 3 });
    const joined: any[] = [];
    for (let i = 0; i < 3; i++) joined.push((await s.join(addr(200 + i))).json);
    const full = await s.join(addr(210));
    expect(full.status).toBe(503);
    await s.place(joined[0].key, 60);
    expect((await s.join(addr(210))).status).toBe(200);
  });
});

describe('abuse protection', () => {
  const lim = (o: Record<string, number>) => ({ readPerMin: 240, joinPerIpPerMin: 20, joinPerWalletPerMin: 6, roundsPerWalletPerHour: 120, placePer10s: 30, ...o });
  it('rate limits moves per key and sends Retry-After', async () => {
    const s = make({ limits: lim({ placePer10s: 5 }) });
    const j = (await s.join(addr(20))).json;
    let limited: any = null;
    for (let i = 0; i < 8 && !limited; i++) {
      const r = await s.place(j.key, 0.1);
      if (r.status === 429) limited = r;
    }
    expect(limited).not.toBeNull();
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
  });
  it('rate limits joins per IP and per wallet', async () => {
    const s = make({ limits: lim({ joinPerIpPerMin: 3, joinPerWalletPerMin: 2 }) });
    const ip = { 'x-forwarded-for': '9.9.9.9' };
    for (let i = 0; i < 3; i++) expect((await s.join(addr(300 + i), 'single', ip)).status).toBe(200);
    expect((await s.join(addr(310), 'single', ip)).status).toBe(429);
    const other = { 'x-forwarded-for': '8.8.8.8' };
    const a = await s.join(addr(320), 'single', other);
    await s.place(a.json.key, 60);
    await s.join(addr(320), 'single', other);
    expect((await s.join(addr(320), 'single', other)).status).toBe(429);
  });
  it('rate limits reads per IP, but not house bots', async () => {
    const s = make({ limits: lim({ readPerMin: 3 }) });
    for (let i = 0; i < 3; i++) expect((await s.call('GET', '/stats')).status).toBe(200);
    expect((await s.call('GET', '/stats')).status).toBe(429);
    expect((await s.call('GET', '/stats', undefined, { 'x-house-secret': HOUSE })).status).toBe(200);
  });
});

describe('server side verification', () => {
  it('rebuilds every round from seed + volume + moves and refuses tampered storage', async () => {
    const s = make();
    const j = (await s.join(addr(30))).json;
    await s.place(j.key, 5);
    const doc: any = await s.store.get(`rounds/${j.roundId}`);
    doc.summary.score = 999;
    await s.store.put(`rounds/${j.roundId}`, doc);
    const r = await s.call('GET', `/state/${j.roundId}`);
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.json)).toContain('integrity_error');
    expect((await s.place(j.key, 5)).status).toBe(500);
  });
  it('replay shows moves of a live round but withholds the seed', async () => {
    const s = make();
    const j = (await s.join(addr(31))).json;
    await s.place(j.key, 5);
    const rep = (await s.call('GET', `/replay/${j.roundId}`)).json;
    expect(rep.seed).toBeNull();
    expect(rep.moves).toHaveLength(1);
    expect((await s.call('GET', '/replay/r_missing')).status).toBe(404);
  });
});

describe('viewer feed and volume', () => {
  it('lists joins, placements and ends in order, with a cursor', async () => {
    const s = make();
    const j = (await s.join(addr(40))).json;
    await s.place(j.key, 20.4);
    await s.call('POST', '/cashout', {}, s.auth(j.key));
    const all = (await s.call('GET', '/events')).json;
    expect(all.events.map((e: any) => e.type)).toEqual(['join', 'place', 'end']);
    const after = (await s.call('GET', `/events?since=${all.events[0].seq}`)).json;
    expect(after.events).toHaveLength(2);
    expect((await s.call('GET', `/events?since=${all.next}`)).json.events).toHaveLength(0);
    expect(JSON.stringify(all)).not.toContain(j.key);
  });
  it('streams events over SSE', async () => {
    const s = make({ sseMaxMs: 600 });
    const j = (await s.join(addr(41))).json;
    const res = await s.app.request('/events?stream=1&since=0');
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    await s.place(j.key, 5);
    const text = await res.text();
    expect(text).toContain(j.roundId);
  });
  it('GET /volume reports the cached live volume', async () => {
    const v = (await make({}, 7071.07).call('GET', '/volume')).json;
    expect(JSON.stringify(v)).toContain('7071.07');
  });
});

import { describe, expect, it } from 'vitest';
import { cashOut, createRound, placeCoin, replay } from '../src/engine.js';
import { createApp } from '../src/server/app.js';
import { appFromEnv, storeFromEnv } from '../src/server/env.js';
import { BlobStore } from '../src/server/store/blob.js';
import { MemoryStore } from '../src/server/store/memory.js';
import type { Store } from '../src/server/store/types.js';
import { FixedVolumeProvider } from '../src/server/volume.js';
import { SEATS_PER_MODE, SLOT_MS, demoRoundId, parseDemoId, planFromId } from '../src/demo/plan.js';
import { INDEX_HTML } from '../src/server/web-assets.generated.js';
import { render } from '../scripts/build-web.js';
import { fakeBlob } from './helpers/fake-blob.js';

const HOUSE = 'house-demo-secret';

function make(store: Store = new MemoryStore(), over: Record<string, unknown> = {}, volumeUsd = 30_000) {
  const clock = { t: 5_000 * SLOT_MS + 1234 };
  const { app } = createApp({ store, volume: new FixedVolumeProvider(volumeUsd), now: () => clock.t, config: { demoMode: true, houseSecret: HOUSE, serverSecret: 'demo-test', ...over } });
  const get = async (path: string, headers: Record<string, string> = {}) => {
    const res = await app.request(path, { headers });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* html or js */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as any };
  };
  return { app, clock, get, post, store };
}

describe('demo rounds are real, deterministic engine rounds', () => {
  it('the id carries everything: same id, same round', () => {
    const id = demoRoundId('twin', 417, 5000, 30000);
    expect(id).toBe('d-twin-0417-5000-30000');
    expect(parseDemoId(id)).toEqual({ mode: 'twin', seat: 417, slot: 5000, volumeUsd: 30000 });
    expect(planFromId(id)).toEqual(planFromId(id));
    expect(planFromId(demoRoundId('twin', 417, 5000, 500))!.seed).not.toBe(planFromId(id)!.seed);
    for (const bad of ['d-twin-1000-1-1', 'x-single-0001-1-1', 'd-quad-0001-1-1', 'd-single-1-1-1', '']) expect(parseDemoId(bad)).toBeNull();
  });

  it('every sampled seat replays exactly to the stated result, in all three modes', () => {
    for (const mode of ['single', 'twin', 'triple'] as const) {
      for (let seat = 0; seat < SEATS_PER_MODE; seat += 37) {
        const plan = planFromId(demoRoundId(mode, seat, 5000, 30000))!;
        const r = replay(plan.seed, plan.mode, plan.volumeUsd, plan.moves);
        expect(r.ok).toBe(true);
        expect(r.state.status).toBe(plan.result.status);
        expect(r.state.score).toBe(plan.result.score);
        expect(r.state.rawScore).toBe(plan.result.rawScore);
        expect(plan.moves.filter((m) => m.type === 'place').length).toBeLessThanOrEqual(60);
        expect(plan.startDelayMs + plan.stepMs * plan.moves.length).toBeLessThan(SLOT_MS - 8000); // every round ends well inside its minute
      }
    }
  });

  it('what the browser does (createRound, then placeCoin or cashOut one by one) gives the same state', () => {
    const plan = planFromId(demoRoundId('triple', 9, 5000, 30000))!;
    let st = createRound(plan.mode, plan.seed, plan.volumeUsd);
    for (const m of plan.moves) st = m.type === 'place' ? placeCoin(st, { dx: m.dx, dy: m.dy }, m.stack) : cashOut(st);
    expect(JSON.stringify(st)).toBe(JSON.stringify(replay(plan.seed, plan.mode, plan.volumeUsd, plan.moves).state));
  });

  it('every sub-arena shows all 10 house archetypes', () => {
    const names = new Set(Array.from({ length: 10 }, (_, t) => planFromId(demoRoundId('single', 230 + t, 5000, 0))!.archetype));
    expect(names.size).toBe(10);
  });
});

describe('demo endpoints', () => {
  it('/demo/tables gives 10 ready-to-replay tables for a sub-arena', async () => {
    const s = make();
    const r = await s.get('/demo/tables?mode=twin&arena=3&sub=4');
    expect(r.status).toBe(200);
    expect(r.json.slot).toBe(5000);
    expect(r.json.volumeUsd).toBe(30000);
    expect(r.json.tables).toHaveLength(10);
    expect(r.json.tables.map((t: any) => t.seat.index)).toEqual(Array.from({ length: 10 }, (_, i) => 340 + i));
    expect(r.json.tables[0]).toMatchObject({ mode: 'twin', house: true });
    expect(r.json.tables[0].seat).toMatchObject({ arena: 3, subArena: 4, table: 0, spot: 0 });
    expect(r.text).not.toContain('demo-test');
  });

  it('rejects bad inputs', async () => {
    const s = make();
    for (const q of ['mode=huge', 'arena=10', 'sub=-1', 'arena=x', 'slot=1', 'slot=99999999', 'vol=7']) {
      const r = await s.get('/demo/tables?' + q);
      expect(r.status, q).toBe(400);
    }
    expect((await s.get('/demo/round/r_1234')).status).toBe(404);
  });

  it('what-if volumes change coin quality; live follows the market reading', async () => {
    const s = make(new MemoryStore(), {}, 7000);
    expect((await s.get('/demo/tables?vol=live')).json.volumeUsd).toBe(7000);
    expect((await s.get('/demo/tables?vol=100000')).json.quality).toBe(1);
    expect((await s.get('/demo/tables?vol=500')).json.quality).toBe(0);
  });

  it('/demo/round/:id and /replay/:id prove the round replays', async () => {
    const s = make();
    const id = demoRoundId('single', 12, 4999, 30000);
    for (const path of [`/demo/round/${id}`, `/replay/${id}`]) {
      const r = await s.get(path);
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ roundId: id, demo: true, ended: true, verified: true, house: true });
      expect(r.json.seed).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it('/demo/config describes the demo', async () => {
    const r = (await make().get('/demo/config')).json;
    expect(r).toMatchObject({ demoMode: true, seatsPerMode: 1000, arenas: 10, subArenas: 10, tablesPerSubArena: 10, slotMs: SLOT_MS });
    expect(r.archetypes).toHaveLength(10);
  });
});

describe('leaderboard and totals tick on request (no cron)', () => {
  for (const [label, mkStore] of [['memory store', () => new MemoryStore() as Store], ['Blob store (fake client)', () => new BlobStore(fakeBlob(), 'demo-test/') as Store]] as const) {
    it(`counts the last finished minute once, then again after the next minute (${label})`, async () => {
      const s = make(mkStore());
      const a = (await s.get('/demo/summary?mode=single')).json;
      expect(a).toMatchObject({ mode: 'single', botsPlaying: 1000, tablesLive: 1000, roundsFinished: 1000, lastSlot: 4999 });
      expect(a.falls + a.cashedOut + a.connected).toBe(1000);
      expect(a.leaderboard.length).toBeGreaterThan(5);
      expect(a.leaderboard[0]).toMatchObject({ house: true, mode: 'single' });
      expect(a.leaderboard[0].score).toBeGreaterThanOrEqual(a.leaderboard[1].score);
      const again = (await s.get('/demo/summary?mode=single')).json;
      expect(again.roundsFinished).toBe(1000); // same minute: not counted twice
      s.clock.t += SLOT_MS;
      const b = (await s.get('/demo/summary?mode=single')).json;
      expect(b).toMatchObject({ roundsFinished: 2000, lastSlot: 5000 });
      const top = b.leaderboard[0];
      const rep = (await s.get(`/replay/${top.roundId}`)).json;
      expect(rep.verified).toBe(true);
      expect(rep.result.score).toBe(top.score);
    });
  }

  it('twin counts connected stacks, and every mode and volume has its own totals', async () => {
    const s = make();
    const t = (await s.get('/demo/summary?mode=twin')).json;
    expect(t.connected).toBeGreaterThan(0);
    const other = (await s.get('/demo/summary?mode=twin&vol=100000')).json;
    expect(other.vol).toBe('100000');
    expect(other.quality).toBe(1);
    expect((await s.get('/demo/summary?mode=triple')).json.mode).toBe('triple');
    expect((await s.get('/demo/summary?mode=bogus')).status).toBe(400);
  });

  it('a second request during a recount does not block or double count', async () => {
    const s = make();
    await s.get('/demo/summary?mode=single');
    s.clock.t += SLOT_MS;
    await s.store.put('demo/lock/single-live', { slot: 5000, at: s.clock.t - 1000 });
    const busy = (await s.get('/demo/summary?mode=single')).json;
    expect(busy.updating).toBe(true);
    expect(busy.roundsFinished).toBe(1000);
  });
});

describe('DEMO_MODE: watch-only for outside users', () => {
  it('blocks join, place, cashout and wallet login for outsiders, with a clear message', async () => {
    const s = make();
    const w = '0x' + '1'.repeat(40);
    for (const [path, body] of [['/join', { wallet: w, mode: 'single' }], ['/place', { dx: 1, dy: 0 }], ['/cashout', {}], ['/auth/nonce', { wallet: w }]] as const) {
      const r = await s.post(path, body);
      expect(r.status, path).toBe(403);
      expect(r.json.error.code).toBe('demo_mode');
      expect(r.json.error.message).toContain('watch-only');
    }
    expect((await s.post('/join', { wallet: w, mode: 'single' }, { 'x-house-secret': 'wrong' })).status).toBe(403);
  });

  it('keeps the API for later: house bots with the secret still play, and reads stay open', async () => {
    const s = make();
    const j = await s.post('/join', { wallet: '0x' + '2'.repeat(40), mode: 'single', botName: 'House' }, { 'x-house-secret': HOUSE });
    expect(j.status).toBe(200);
    expect((await s.post('/place', { dx: 3, dy: 0, stack: 0 }, { authorization: `Bearer ${j.json.key}`, 'x-house-secret': HOUSE })).status).toBe(200);
    expect((await s.get('/leaderboard')).status).toBe(200);
    expect((await s.get('/llms.txt')).status).toBe(200);
  });

  it('turning it off restores the open API', async () => {
    const s = make(new MemoryStore(), { demoMode: false });
    expect((await s.post('/join', { wallet: '0x' + '3'.repeat(40), mode: 'single' })).status).toBe(200);
  });

  it('is on by default for the deployed entry and off with DEMO_MODE=off', async () => {
    const prev = process.env.DEMO_MODE;
    try {
      delete process.env.DEMO_MODE;
      expect((await appFromEnv()).config.demoMode).toBe(true);
      process.env.DEMO_MODE = 'off';
      expect((await appFromEnv()).config.demoMode).toBe(false);
      process.env.DEMO_MODE = 'on';
      expect((await appFromEnv()).config.demoMode).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.DEMO_MODE;
      else process.env.DEMO_MODE = prev;
    }
  });

  it('runs with zero setup: no Blob token means memory', async () => {
    const keys = ['BLOB_READ_WRITE_TOKEN', 'BLOB_STORE_ID', 'DATA_DIR'];
    const saved = keys.map((k) => process.env[k]);
    keys.forEach((k) => delete process.env[k]);
    try {
      expect((await storeFromEnv()).kind).toBe('memory');
    } finally {
      keys.forEach((k, i) => { if (saved[i] !== undefined) process.env[k] = saved[i]!; });
    }
  });
});

describe('/demo/overview (colors for the ring of arenas)', () => {
  it('lists all 1000 seats and agrees with the full table plans', async () => {
    const s = make();
    const o = await s.get('/demo/overview?mode=twin');
    expect(o.status).toBe(200);
    expect(o.json.seats).toHaveLength(1000);
    expect(o.json.slot).toBe(5000);
    const t = await s.get('/demo/tables?mode=twin&arena=7&sub=2');
    t.json.tables.forEach((plan: any, i: number) => {
      const row = o.json.seats[plan.seat.index];
      expect(plan.seat.index).toBe(720 + i);
      expect(row[0]).toBe(plan.startDelayMs);
      expect(row[1]).toBe(plan.stepMs);
      expect(row[2]).toBe(plan.moves.length);
      expect(row[4]).toBe(plan.result.score);
      expect(row[5]).toBe(plan.result.coinsOnTable);
      expect([1, 2, 3]).toContain(row[3]);
      expect(row[3] === 1).toBe(plan.result.status === 'fell');
    });
  });

  it('checks its inputs and works for every mode', async () => {
    const s = make();
    for (const q of ['mode=huge', 'slot=1', 'slot=99999999', 'vol=7']) expect((await s.get('/demo/overview?' + q)).status, q).toBe(400);
    for (const m of ['single', 'twin', 'triple']) expect((await s.get('/demo/overview?mode=' + m + '&vol=5000')).json.seats).toHaveLength(1000);
  });

  it('is cacheable for what-if volumes only', async () => {
    const s = make();
    expect((await s.get('/demo/overview?vol=5000')).headers.get('cache-control')).toContain('s-maxage');
    expect((await s.get('/demo/overview?vol=live')).headers.get('cache-control') ?? '').not.toContain('s-maxage');
  });
});

describe('the page', () => {
  it('serves the viewer at / for browsers and JSON for everything else', async () => {
    const s = make();
    const page = await s.get('/', { accept: 'text/html,application/xhtml+xml' });
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.text).toContain('CAPHET');
    expect(page.text).toContain('/demo.js');
    expect(page.text).not.toMatch(/<button[^>]*>\s*(join|connect wallet)/i);
    const js = await s.get('/demo.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('javascript');
    expect(js.text).toContain('/demo/tables');
    expect((await s.get('/', { accept: 'application/json' })).json).toMatchObject({ demoMode: true, viewer: '/' });
    const closed = make(new MemoryStore(), { demoMode: false });
    expect((await closed.get('/', { accept: 'text/html' })).json.viewer).toBeNull();
  });

  it('the committed page bundle is up to date (run npm run build:web after changing web/ or the engine)', async () => {
    const { readFileSync } = await import('node:fs');
    const cur = readFileSync(new URL('../src/server/web-assets.generated.ts', import.meta.url), 'utf8');
    expect(cur).toBe(await render());
    expect(INDEX_HTML.length).toBeGreaterThan(1000);
  });
});

describe('Vercel entry (api/index.ts)', () => {
  it('exports a Web Standard fetch handler that serves the page and the API with no environment variables', async () => {
    const keys = ['BLOB_READ_WRITE_TOKEN', 'BLOB_STORE_ID', 'DATA_DIR', 'DEMO_MODE', 'CHAIN_RECORDS', 'AUTH_MODE'];
    const saved = keys.map((k) => process.env[k]);
    keys.forEach((k) => delete process.env[k]);
    process.env.VOLUME_OVERRIDE_USD = '12000';
    try {
      const mod = (await import('../api/index.js')).default;
      expect(typeof mod.fetch).toBe('function');
      const page = await mod.fetch(new Request('https://arena.example/', { headers: { accept: 'text/html' } }));
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('CAPHET');
      const t = (await (await mod.fetch(new Request('https://arena.example/demo/tables?mode=single'))).json()) as any;
      expect(t.tables).toHaveLength(10);
      expect(t.volumeUsd).toBe(12000);
      const join = await mod.fetch(new Request('https://arena.example/join', { method: 'POST', body: JSON.stringify({ wallet: '0x' + '4'.repeat(40), mode: 'single' }) }));
      expect(join.status).toBe(403);
    } finally {
      delete process.env.VOLUME_OVERRIDE_USD;
      keys.forEach((k, i) => { if (saved[i] !== undefined) process.env[k] = saved[i]!; });
    }
  });
});

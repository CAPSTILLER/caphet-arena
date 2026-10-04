import { spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runHouseBots } from '../scripts/house-bots.js';
import { createApp } from '../src/server/app.js';
import { startServer } from '../src/server/node.js';
import { MemoryStore } from '../src/server/store/memory.js';
import type { VaultDoc, WalletDoc } from '../src/server/types.js';
import { FixedVolumeProvider } from '../src/server/volume.js';

const HOUSE = 'e2e-house-secret';
let server: Awaited<ReturnType<typeof startServer>>;
const store = new MemoryStore();
let config: ReturnType<typeof createApp>['config'];

beforeAll(async () => {
  const made = createApp({
    store,
    volume: new FixedVolumeProvider(30_000),
    config: { houseSecret: HOUSE, serverSecret: 'e2e', sseMaxMs: 800 },
  });
  config = made.config;
  server = await startServer(made.app, 0);
});
afterAll(async () => {
  await server.close();
});

function runAgent(baseUrl: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--import', 'tsx', 'examples/agent.ts'], { env: { ...process.env, BASE_URL: baseUrl }, cwd: process.cwd() });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });
}

describe('end to end over real HTTP', () => {
  it('the example agent joins, places coins and cashes out', async () => {
    const r = await runAgent(server.url);
    expect(r.out).toContain('joined');
    expect(r.out).toContain('done:');
    expect(r.code).toBe(0);
  }, 30_000);

  it('all 10 house bots play every mode through the API only, and are marked house', async () => {
    const results = await runHouseBots(server.url, 6, HOUSE);
    expect(results).toHaveLength(60);
    expect(new Set(results.map((r) => r.archetype)).size).toBe(10);
    expect(new Set(results.map((r) => r.mode)).size).toBe(3);
    expect(results.every((r) => ['cashed', 'fell', 'touched', 'maxed'].includes(r.status))).toBe(true);

    const lb = (await (await fetch(`${server.url}/leaderboard`)).json()) as any;
    const entries = [...lb.leaderboard.single, ...lb.leaderboard.twin, ...lb.leaderboard.triple];
    expect(entries.length).toBeGreaterThan(10);
    const house = entries.filter((e: any) => e.house);
    expect(house.length).toBeGreaterThanOrEqual(10);
    // the example agent (no house secret) is on the board as a normal player
    expect(entries.some((e: any) => !e.house)).toBe(true);
  }, 120_000);

  it('every round was replayed and verified by the server, and the viewer feed saw them', async () => {
    const ends: any[] = [];
    let since = 0;
    for (let page = 0; page < 100; page++) {
      const ev = (await (await fetch(`${server.url}/events?since=${since}`)).json()) as any;
      if (ev.events.length === 0) break;
      ends.push(...ev.events.filter((e: any) => e.type === 'end'));
      since = ev.next;
    }
    expect(ends.length).toBeGreaterThan(5); // the feed keeps the last 500 events only
    for (const e of ends.slice(-10)) {
      const rep = (await (await fetch(`${server.url}/replay/${e.roundId}`)).json()) as any;
      expect(rep.verified).toBe(true);
      expect(rep.seedMatchesCommit).toBe(true);
      expect(rep.moves.length).toBeGreaterThan(0);
    }
  }, 60_000);

  it('all seats are free again and play coins are conserved', async () => {
    const stats = (await (await fetch(`${server.url}/stats`)).json()) as any;
    for (const m of ['single', 'twin', 'triple']) expect(stats.seats[m].used).toBe(0);
    const vault = (await store.get<VaultDoc>('vault'))!;
    let wallets = 0;
    let sum = 0;
    for (const k of await store.list('wallets/')) {
      const w = (await store.get<WalletDoc>(k))!;
      wallets++;
      sum += w.balance;
    }
    expect(wallets).toBe(11);
    expect(sum + vault.balance + vault.treasury).toBeCloseTo(config.vaultStart + wallets * config.startingBalance + vault.totals.houseTopUps, 6);
  });

  it('SSE delivers a live join to a connected viewer', async () => {
    const res = await fetch(`${server.url}/events?stream=1`);
    const reader = res.body!.getReader();
    const join = await fetch(`${server.url}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wallet: '0x' + 'ab'.repeat(20), mode: 'single', botName: 'Viewer Test' }),
    });
    const j = (await join.json()) as any;
    let text = '';
    const dec = new TextDecoder();
    const t0 = Date.now();
    while (!text.includes(j.roundId) && Date.now() - t0 < 5000) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value);
    }
    await reader.cancel();
    expect(text).toContain(j.roundId);
  }, 15_000);
});

import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { MockRecorder, buildChainRecord, movesString, recorderFromEnv, volumeBucketOf } from '../src/chain/records.js';
import { createApp } from '../src/server/app.js';
import { appFromEnv } from '../src/server/env.js';
import { MemoryStore } from '../src/server/store/memory.js';
import { FixedVolumeProvider } from '../src/server/volume.js';
import { sha256Hex } from '../src/server/auth.js';

const addr = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;
const HOUSE = 'house-chain';
const ADMIN = 'admin-chain';

function make(rec: MockRecorder | null, over: Record<string, unknown> = {}) {
  const { app, service } = createApp({
    store: new MemoryStore(),
    volume: new FixedVolumeProvider(100_000),
    recorder: rec,
    config: { houseSecret: HOUSE, adminSecret: ADMIN, serverSecret: 'chain-test', ...over },
  });
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text.startsWith('{') ? JSON.parse(text) : null };
  };
  const play = async (wallet: string, dx: number, headers: Record<string, string> = {}) => {
    const j = (await call('POST', '/join', { wallet, mode: 'single', botName: 'Chain' }, headers)).json;
    const auth = { authorization: `Bearer ${j.key}` };
    const p = await call('POST', '/place', { dx, dy: 0, stack: 0 }, auth);
    const end = p.json.status === 'active' ? await call('POST', '/cashout', {}, auth) : p;
    return { roundId: j.roundId as string, end: end.json };
  };
  return { app, service, call, play };
}

describe('onchain round records (mock recorder)', () => {
  it('is off by default: nothing is written and chain is null', async () => {
    const s = make(null);
    expect((await s.call('GET', '/chain')).json.enabled).toBe(false);
    const { roundId } = await s.play(addr(1), 20.4);
    const rep = (await s.call('GET', `/replay/${roundId}`)).json;
    expect(rep.chain).toBeNull();
  });

  it('writes a finished round with the right fields, and reports the tx in /replay', async () => {
    const rec = new MockRecorder();
    const s = make(rec);
    const { roundId } = await s.play(addr(2), 20.4);
    expect(rec.records.size).toBe(1);
    const r = [...rec.records.values()][0]!;
    const rep = (await s.call('GET', `/replay/${roundId}`)).json;
    expect(rep.chain).toMatchObject({ status: 'recorded', attempts: 1 });
    expect(r.roundId).toBe(keccak256(toHex(roundId)));
    expect(r.wallet.toLowerCase()).toBe(addr(2));
    expect(r).toMatchObject({ mode: 0, outcome: 1, score: 20, volumeBucket: 10 });
    expect(r.seedCommit).toBe(`0x${rep.seedCommit}`);
    expect(r.seedCommit).toBe(`0x${sha256Hex(`${roundId}:${rep.seed}`)}`);
    expect(r.movesHash).toBe(keccak256(toHex(movesString(rep.moves))));
    expect(movesString(rep.moves)).toBe('p:0:20.4:0;c');
    expect((await s.call('GET', '/chain')).json).toMatchObject({ enabled: true, kind: 'mock', recorded: 1 });
  });

  it('records a fall as outcome 0 with score 0', async () => {
    const rec = new MockRecorder();
    const s = make(rec);
    await s.play(addr(3), 60);
    expect([...rec.records.values()][0]).toMatchObject({ outcome: 0, score: 0 });
  });

  it('records the full score, not the payout-capped one', () => {
    const rec = buildChainRecord({
      id: 'r_x', wallet: addr(4), mode: 'single', quality: 0.5, seedCommit: 'ab'.repeat(32), moves: [{ type: 'cashout' }],
      ledger: { mode: 'single', outcome: 'cashed_scored', stake: 0, score: 25000, rawScore: 25000, payout: 10000, payoutCapped: true, recordedScore: 25000, newHighScore: 25000, vaultToWallet: 10000, vaultToTreasury: 0 } as any,
    });
    expect(rec.score).toBe(25000);
    expect(rec.volumeBucket).toBe(5);
    expect(volumeBucketOf(0)).toBe(0);
    expect(volumeBucketOf(1.4)).toBe(10);
  });

  it('keeps house bot rounds off the chain unless asked', async () => {
    const rec = new MockRecorder();
    const s = make(rec);
    const { roundId } = await s.play(addr(5), 20.4, { 'x-house-secret': HOUSE });
    expect(rec.records.size).toBe(0);
    expect((await s.call('GET', `/replay/${roundId}`)).json.chain).toBeNull();
    const rec2 = new MockRecorder();
    await make(rec2, { chainRecordHouse: true }).play(addr(5), 20.4, { 'x-house-secret': HOUSE });
    expect(rec2.records.size).toBe(1);
  });

  it('a chain failure never breaks the game; the admin flush retries it, once', async () => {
    const rec = new MockRecorder();
    rec.failNext = 1;
    const s = make(rec);
    const { roundId, end } = await s.play(addr(6), 20.4);
    expect(end.status).toBe('cashed');
    expect(end.ledger.payout).toBe(20);
    expect((await s.call('GET', `/replay/${roundId}`)).json.chain).toMatchObject({ status: 'failed', error: 'mock chain failure' });
    expect(rec.records.size).toBe(0);

    expect((await s.call('POST', '/admin/chain/flush')).status).toBe(401);
    expect((await s.call('POST', '/admin/chain/flush', {}, { 'x-admin-secret': 'nope' })).status).toBe(401);
    const f = await s.call('POST', '/admin/chain/flush', {}, { 'x-admin-secret': ADMIN });
    expect(f.json).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    expect((await s.call('GET', `/replay/${roundId}`)).json.chain).toMatchObject({ status: 'recorded', attempts: 2 });
    expect(rec.records.size).toBe(1);
    expect((await s.call('POST', '/admin/chain/flush', {}, { 'x-admin-secret': ADMIN })).json.attempted).toBe(0);
  });

  it('a slow chain does not hold the answer longer than chainWaitMs', async () => {
    const slow = new MockRecorder();
    const orig = slow.record.bind(slow);
    slow.record = async (r) => (await new Promise((res) => setTimeout(res, 400)), orig(r));
    const s = make(slow, { chainWaitMs: 50 });
    const t0 = Date.now();
    const { roundId, end } = await s.play(addr(7), 20.4);
    expect(Date.now() - t0).toBeLessThan(380);
    expect(end.status).toBe('cashed');
    expect((await s.call('GET', `/replay/${roundId}`)).json.chain).toMatchObject({ status: 'pending' });
    await new Promise((r) => setTimeout(r, 500));
    // the late transaction landed; the flush finds it recorded and does not send a second one
    await s.call('POST', '/admin/chain/flush', {}, { 'x-admin-secret': ADMIN });
    expect(slow.records.size).toBe(1);
  });

  it('refuses to start with real chain writes unless wallet signatures are on', async () => {
    const fake = { kind: 'viem', record: async () => ({ txHash: '0x' }), info: () => ({}) };
    await expect(appFromEnv({ recorder: fake as any, config: { authMode: 'open' } })).rejects.toThrow(/AUTH_MODE=signature/);
    await expect(appFromEnv({ recorder: fake as any, config: { authMode: 'signature' } })).resolves.toBeTruthy();
  });

  it('reads chain settings from the environment, off unless fully configured', () => {
    expect(recorderFromEnv({})).toBeNull();
    expect(recorderFromEnv({ CHAIN_RECORDS: 'mock' } as any)?.kind).toBe('mock');
    expect(() => recorderFromEnv({ CHAIN_RECORDS: 'on' } as any)).toThrow(/needs/);
    expect(() => recorderFromEnv({ CHAIN_RECORDS: 'on', CHAIN_ID: '1', CHAIN_RPC_URL: 'x', GAME_RECORDS_ADDRESS: 'x', OPERATOR_PRIVATE_KEY: 'x' } as any)).toThrow(/CHAIN_ID/);
    const real = recorderFromEnv({
      CHAIN_RECORDS: 'on', CHAIN_ID: '84532', CHAIN_RPC_URL: 'http://127.0.0.1:1', GAME_RECORDS_ADDRESS: addr(9),
      OPERATOR_PRIVATE_KEY: '0x' + '11'.repeat(32),
    } as any)!;
    expect(real.info()).toMatchObject({ kind: 'viem', chainId: 84532 });
  });
});

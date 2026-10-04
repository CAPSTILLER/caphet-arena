import { describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { parseSiweMessage } from 'viem/siwe';
import { createApp } from '../src/server/app.js';
import { MemoryStore } from '../src/server/store/memory.js';
import { FixedVolumeProvider } from '../src/server/volume.js';

const HOUSE = 'house-secret-auth';

function make(over: Record<string, unknown> = {}) {
  const clock = { t: Date.UTC(2026, 9, 4, 12, 0, 0) };
  const { app } = createApp({
    store: new MemoryStore(),
    volume: new FixedVolumeProvider(50_000),
    now: () => clock.t,
    config: { houseSecret: HOUSE, serverSecret: 'auth-test', authMode: 'signature', authDomain: 'arena.test', authChainId: 84532, ...over },
  });
  const call = async (path: string, body?: unknown, headers: Record<string, string> = {}, method = 'POST') => {
    const res = await app.request(path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text.startsWith('{') ? JSON.parse(text) : null, text };
  };
  return { app, clock, call };
}

async function login(s: ReturnType<typeof make>, acct = privateKeyToAccount(generatePrivateKey())) {
  const n = await s.call('/auth/nonce', { wallet: acct.address });
  expect(n.status).toBe(200);
  const signature = await acct.signMessage({ message: n.json.message });
  return { acct, nonce: n.json.nonce as string, message: n.json.message as string, signature };
}

describe('wallet signature login', () => {
  it('issues a sign-in-with-Ethereum message with nonce, domain, chain and expiry', async () => {
    const s = make();
    const acct = privateKeyToAccount(generatePrivateKey());
    const n = await s.call('/auth/nonce', { wallet: acct.address.toLowerCase() });
    const m = parseSiweMessage(n.json.message);
    expect(m.address).toBe(acct.address);
    expect(m.domain).toBe('arena.test');
    expect(m.chainId).toBe(84532);
    expect(m.nonce).toBe(n.json.nonce);
    expect(m.expirationTime!.getTime() - m.issuedAt!.getTime()).toBe(5 * 60_000);
    expect(n.json.authMode).toBe('signature');
  });

  it('refuses /join without a signature, with a pointer to /auth/nonce', async () => {
    const s = make();
    const acct = privateKeyToAccount(generatePrivateKey());
    const r = await s.call('/join', { wallet: acct.address, mode: 'single' });
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe('signature_required');
    expect(r.json.error.message).toContain('/auth/nonce');
  });

  it('accepts a valid signature once and issues the usual API key', async () => {
    const s = make();
    const l = await login(s);
    const j = await s.call('/join', { wallet: l.acct.address, mode: 'single', botName: 'Signer', auth: { nonce: l.nonce, signature: l.signature } });
    expect(j.status).toBe(200);
    expect(j.json.key).toMatch(/^sk_/);
    const p = await s.call('/place', { dx: 5, dy: 0, stack: 0 }, { authorization: `Bearer ${j.json.key}` });
    expect(p.status).toBe(200);
    // replaying the same signature fails, nonces are single use
    await s.call('/cashout', {}, { authorization: `Bearer ${j.json.key}` });
    const again = await s.call('/join', { wallet: l.acct.address, mode: 'single', auth: { nonce: l.nonce, signature: l.signature } });
    expect(again.status).toBe(401);
    expect(['bad_nonce', 'nonce_used']).toContain(again.json.error.code);
  });

  it('rejects a signature from a different wallet', async () => {
    const s = make();
    const victim = privateKeyToAccount(generatePrivateKey());
    const attacker = privateKeyToAccount(generatePrivateKey());
    const n = await s.call('/auth/nonce', { wallet: victim.address });
    const signature = await attacker.signMessage({ message: n.json.message });
    const r = await s.call('/join', { wallet: victim.address, mode: 'single', auth: { nonce: n.json.nonce, signature } });
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe('bad_signature');
  });

  it('rejects a signature over a different message', async () => {
    const s = make();
    const acct = privateKeyToAccount(generatePrivateKey());
    const n = await s.call('/auth/nonce', { wallet: acct.address });
    const signature = await acct.signMessage({ message: n.json.message + '\nextra' });
    expect((await s.call('/join', { wallet: acct.address, mode: 'single', auth: { nonce: n.json.nonce, signature } })).json.error.code).toBe('bad_signature');
  });

  it('rejects a nonce that was issued to another wallet or never issued', async () => {
    const s = make();
    const a = await login(s);
    const other = privateKeyToAccount(generatePrivateKey());
    const r = await s.call('/join', { wallet: other.address, mode: 'single', auth: { nonce: a.nonce, signature: a.signature } });
    expect(r.json.error.code).toBe('bad_nonce');
    const fake = await s.call('/join', { wallet: other.address, mode: 'single', auth: { nonce: 'a'.repeat(32), signature: a.signature } });
    expect(fake.json.error.code).toBe('bad_nonce');
  });

  it('rejects an expired nonce', async () => {
    const s = make();
    const l = await login(s);
    s.clock.t += 5 * 60_000 + 1;
    const r = await s.call('/join', { wallet: l.acct.address, mode: 'single', auth: { nonce: l.nonce, signature: l.signature } });
    expect(r.json.error.code).toBe('nonce_expired');
  });

  it('lets only one of many parallel joins use the same nonce', async () => {
    const s = make();
    const l = await login(s);
    const rs = await Promise.all(Array.from({ length: 5 }, () => s.call('/join', { wallet: l.acct.address, mode: 'single', auth: { nonce: l.nonce, signature: l.signature } })));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
  });

  it('lets house bots skip the signature only with the house secret', async () => {
    const s = make();
    const w = '0x' + '12'.repeat(20);
    expect((await s.call('/join', { wallet: w, mode: 'single' }, { 'x-house-secret': HOUSE })).status).toBe(200);
    expect((await s.call('/join', { wallet: '0x' + '34'.repeat(20), mode: 'single' }, { 'x-house-secret': 'wrong' })).status).toBe(401);
  });

  it('can use a custom verifier (for smart wallets) and validates the wallet field', async () => {
    const calls: string[] = [];
    const clock = { t: 1_000_000 };
    const { app } = createApp({
      store: new MemoryStore(),
      volume: new FixedVolumeProvider(1000),
      now: () => clock.t,
      config: { authMode: 'signature' },
      signatureVerifier: async (a) => (calls.push(a), true),
    });
    const w = '0x' + '56'.repeat(20);
    const n = await (await app.request('/auth/nonce', { method: 'POST', body: JSON.stringify({ wallet: w }) })).json() as any;
    const j = await app.request('/join', { method: 'POST', body: JSON.stringify({ wallet: w, mode: 'single', auth: { nonce: n.nonce, signature: '0x' + 'ab'.repeat(65) } }) });
    expect(j.status).toBe(200);
    expect(calls).toEqual([w]);
    expect((await app.request('/auth/nonce', { method: 'POST', body: JSON.stringify({ wallet: 'nope' }) })).status).toBe(400);
  });

  it('open mode (default) still joins with just an address, and says so in the docs', async () => {
    const s = make({ authMode: 'open' });
    expect((await s.call('/join', { wallet: '0x' + '78'.repeat(20), mode: 'single' })).status).toBe(200);
    const llms = (await s.call('/llms.txt', undefined, {}, 'GET')).text;
    expect(llms).toContain('authMode "open"');
    const spec = (await s.call('/openapi.json', undefined, {}, 'GET')).json;
    expect(Object.keys(spec.paths)).toContain('/auth/nonce');
    expect(JSON.stringify(spec.components.schemas.JoinRequest)).toContain('auth');
  });
});

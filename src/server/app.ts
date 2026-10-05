import { timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { qualityFromVolume, type Mode } from '../index.js';
import { normalizeWallet } from './auth.js';
import type { RoundRecorder } from '../chain/records.js';
import { WalletAuth, type SignatureVerifier } from './siwe.js';
import { defaultConfig, type ServerConfig } from './config.js';
import { llmsTxt, openApi } from './docs.js';
import { ApiError } from './errors.js';
import { MemoryRateLimiter, type RateLimiter } from './ratelimit.js';
import { GameService } from './service.js';
import { MemoryStore } from './store/memory.js';
import type { Store } from './store/types.js';
import { DemoService } from '../demo/service.js';
import { APP_JS, INDEX_HTML, MINT_HTML } from './web-assets.generated.js';
import { LiveVolumeProvider, type VolumeProvider } from './volume.js';

export interface AppDeps {
  store?: Store;
  config?: Partial<ServerConfig>;
  volume?: VolumeProvider;
  limiter?: RateLimiter;
  now?: () => number;
  randomHex?: (bytes: number) => string;
  randomInt?: (max: number) => number;
  /** Public base URL shown in the docs. Defaults to the request origin. */
  baseUrl?: string;
  /** Replace the signature check (default: EOA personal_sign via viem). Use to add ERC-1271 smart wallets or a test double. */
  signatureVerifier?: SignatureVerifier;
  /** Onchain record writer. Omit for none (default). */
  recorder?: RoundRecorder | null;
}

const MODES = ['single', 'twin', 'triple'] as const;
const BOT_NAME_RE = /^[\w .\-]{1,32}$/;

export function createApp(deps: AppDeps = {}): { app: Hono; service: GameService; config: ServerConfig } {
  const config = defaultConfig(deps.config);
  const store = deps.store ?? new MemoryStore();
  const now = deps.now ?? Date.now;
  const limiter = deps.limiter ?? new MemoryRateLimiter(now);
  const volume = deps.volume ?? new LiveVolumeProvider(config.fallbackVolumeUsd);
  const service = new GameService({ store, config, volume, now, randomHex: deps.randomHex, randomInt: deps.randomInt, recorder: deps.recorder });
  const demo = new DemoService(store, volume, now);
  const walletAuth = new WalletAuth(store, { domain: config.authDomain, chainId: config.authChainId, nonceTtlMs: config.nonceTtlMs }, now, deps.signatureVerifier);
  const app = new Hono();

  app.use('*', cors({ origin: '*', allowHeaders: ['content-type', 'authorization', 'x-api-key', 'x-house-secret'], exposeHeaders: ['retry-after'] }));

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      if (err.retryAfterSec) c.header('retry-after', String(err.retryAfterSec));
      return c.json({ error: { code: err.code, message: err.message, ...err.extra } }, err.status as 400);
    }
    console.error('unhandled', err);
    return c.json({ error: { code: 'server_error', message: 'Something went wrong on our side.' } }, 500);
  });
  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'No such endpoint. See /llms.txt' } }, 404));

  // ---- helpers ----------------------------------------------------------
  const baseUrl = (c: Context): string => deps.baseUrl ?? new URL(c.req.url).origin;
  const ipOf = (c: Context): string => {
    const xff = c.req.header('x-forwarded-for');
    if (xff) return xff.split(',')[0]!.trim();
    return c.req.header('x-real-ip') ?? 'local';
  };
  const isHouse = (c: Context): boolean => {
    const given = c.req.header('x-house-secret');
    if (!config.houseSecret || !given) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(config.houseSecret);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const limit = (bucket: string, max: number, windowMs: number, what: string): void => {
    const wait = limiter.hit(bucket, max, windowMs);
    if (wait !== null) throw new ApiError(429, 'rate_limited', `Too many ${what}. Slow down.`, { retryAfterMs: wait }, Math.max(1, Math.ceil(wait / 1000)));
  };
  const readLimit = (c: Context): void => {
    if (!isHouse(c)) limit(`read:${ipOf(c)}`, config.limits.readPerMin, 60_000, 'requests');
  };
  const readBody = async (c: Context): Promise<Record<string, unknown>> => {
    const declared = Number(c.req.header('content-length') ?? 0);
    if (declared > config.maxBodyBytes) throw new ApiError(413, 'body_too_large', `Body larger than ${config.maxBodyBytes} bytes.`);
    const text = await c.req.text();
    if (text.length > config.maxBodyBytes) throw new ApiError(413, 'body_too_large', `Body larger than ${config.maxBodyBytes} bytes.`);
    if (text.trim() === '') return {};
    try {
      const v = JSON.parse(text);
      if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
      return v as Record<string, unknown>;
    } catch {
      throw new ApiError(400, 'bad_json', 'Body must be a JSON object.');
    }
  };
  const keyOf = (c: Context): string | null => {
    const auth = c.req.header('authorization');
    if (auth && /^bearer /i.test(auth)) return auth.slice(7).trim();
    return c.req.header('x-api-key') ?? null;
  };

  // ---- docs -------------------------------------------------------------
  app.get('/', (c) => {
    if (config.demoMode && (c.req.header('accept') ?? '').includes('text/html')) {
      return c.html(INDEX_HTML, 200, { 'cache-control': 'no-cache' });
    }
    return c.json({ name: 'CAPHET AI Bot Arena', demoMode: config.demoMode, authMode: config.authMode, viewer: config.demoMode ? '/' : null, mint: '/mint', demo: '/demo/config', rules: '/llms.txt', spec: '/openapi.json', health: '/health' });
  });
  app.get('/demo.js', (c) => c.body(APP_JS, 200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' }));
  app.get('/mint', (c) => c.html(MINT_HTML, 200, { 'cache-control': 'no-cache' }));
  // Public icons / PWA (also in /public for Vercel static). Local serve hits these.
  const publicFile = async (c: Context, name: string, type: string) => {
    try {
      const { readFile } = await import('node:fs/promises');
      const { fileURLToPath } = await import('node:url');
      const root = fileURLToPath(new URL('../../..', import.meta.url));
      const buf = await readFile(root + 'public/' + name);
      return c.body(buf, 200, { 'content-type': type, 'cache-control': 'public, max-age=86400' });
    } catch {
      return c.body(null, 404);
    }
  };
  app.get('/favicon.ico', (c) => publicFile(c, 'favicon.ico', 'image/x-icon'));
  app.get('/favicon-32.png', (c) => publicFile(c, 'favicon-32.png', 'image/png'));
  app.get('/apple-touch-icon.png', (c) => publicFile(c, 'apple-touch-icon.png', 'image/png'));
  app.get('/icon-192.png', (c) => publicFile(c, 'icon-192.png', 'image/png'));
  app.get('/icon-512.png', (c) => publicFile(c, 'icon-512.png', 'image/png'));
  app.get('/og.jpg', (c) => publicFile(c, 'og.jpg', 'image/jpeg'));
  app.get('/manifest.webmanifest', (c) => publicFile(c, 'manifest.webmanifest', 'application/manifest+json'));
  app.get('/health', (c) => c.json({ ok: true, time: now() }));
  app.get('/llms.txt', (c) => c.text(llmsTxt(config, baseUrl(c)), 200, { 'content-type': 'text/plain; charset=utf-8' }));
  app.get('/openapi.json', (c) => c.json(openApi(baseUrl(c), config.authMode)));

  // ---- volume -----------------------------------------------------------
  app.get('/volume', async (c) => {
    readLimit(c);
    const v = await volume.get();
    return c.json({
      volume24hUsd: v.volumeUsd,
      quality: qualityFromVolume(v.volumeUsd),
      source: v.source,
      fetchedAt: v.fetchedAtMs,
      priceUsd: v.priceUsd,
      liquidityUsd: v.liquidityUsd,
      scale: 'quality 0 at or below $500, 1 at or above $100,000, log scale between',
    });
  });

  // ---- join -------------------------------------------------------------
  app.post('/join', async (c) => {
    demoGate(c);
    const house = isHouse(c);
    if (!house) limit(`join-ip:${ipOf(c)}`, config.limits.joinPerIpPerMin, 60_000, 'join requests from this IP');
    const body = await readBody(c);
    const wallet = normalizeWallet(body.wallet);
    if (!wallet) throw new ApiError(400, 'bad_wallet', 'wallet must be an address like 0x followed by 40 hex characters.');
    if (typeof body.mode !== 'string' || !(MODES as readonly string[]).includes(body.mode)) {
      throw new ApiError(400, 'bad_mode', 'mode must be single, twin or triple.');
    }
    const botName = body.botName === undefined ? 'anonymous' : body.botName;
    if (typeof botName !== 'string' || !BOT_NAME_RE.test(botName)) {
      throw new ApiError(400, 'bad_bot_name', 'botName must be 1 to 32 letters, digits, spaces, dots, dashes or underscores.');
    }
    if (!house) {
      limit(`join-wallet:${wallet}`, config.limits.joinPerWalletPerMin, 60_000, 'join requests for this wallet');
      limit(`join-hour:${wallet}`, config.limits.roundsPerWalletPerHour, 3_600_000, 'rounds for this wallet this hour');
    }
    // wallet login: in signature mode the caller must prove they own the wallet. House bots are operator-run and skip it.
    if (config.authMode === 'signature' && !house) await walletAuth.check(wallet, body.auth);
    return c.json(await service.join({ wallet, mode: body.mode as Mode, botName, house }));
  });

  // ---- watch-only demo (always on the API, the page is shown when DEMO_MODE is on) ----
  const parseMode = (v: string | undefined): Mode => {
    const m = v ?? 'single';
    if (!(MODES as readonly string[]).includes(m)) throw new ApiError(400, 'bad_mode', 'mode must be single, twin or triple.');
    return m as Mode;
  };
  const intIn = (v: string | undefined, name: string, lo: number, hi: number, dflt: number): number => {
    if (v === undefined || v === '') return dflt;
    const n = Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) throw new ApiError(400, 'bad_' + name, `${name} must be a whole number from ${lo} to ${hi}.`);
    return n;
  };
  app.get('/demo/config', async (c) => {
    readLimit(c);
    return c.json({ ...(await demo.config()), demoMode: config.demoMode });
  });
  app.get('/demo/tables', async (c) => {
    readLimit(c);
    const slotQ = c.req.query('slot');
    return c.json(
      await demo.tables(parseMode(c.req.query('mode')), intIn(c.req.query('arena'), 'arena', 0, 9, 0), intIn(c.req.query('sub'), 'sub', 0, 9, 0), slotQ === undefined ? null : intIn(slotQ, 'slot', 0, 1e9, 0), c.req.query('vol') ?? 'live'),
      200,
      { 'cache-control': 'public, max-age=30' },
    );
  });
  app.get('/demo/overview', async (c) => {
    readLimit(c);
    const slotQ = c.req.query('slot');
    const vol = c.req.query('vol') ?? 'live';
    const body = await demo.overview(parseMode(c.req.query('mode')), slotQ === undefined ? null : intIn(slotQ, 'slot', 0, 1e9, 0), vol);
    if (vol !== 'live') c.header('cache-control', 'public, max-age=20, s-maxage=60, stale-while-revalidate=60');
    return c.json(body);
  });
  app.get('/demo/summary', async (c) => {
    readLimit(c);
    return c.json(await demo.summary(parseMode(c.req.query('mode')), c.req.query('vol') ?? 'live'));
  });
  app.get('/demo/round/:id', (c) => {
    readLimit(c);
    return c.json(demo.roundView(c.req.param('id')));
  });
  /** Watch-only demo: outside users cannot start or play rounds. House bots with the house secret still can. */
  const demoGate = (c: Context): void => {
    if (config.demoMode && !isHouse(c)) {
      throw new ApiError(403, 'demo_mode', 'This server is a watch-only demo. Joining and playing are switched off. Watch the house bots at / and read the rules at /llms.txt.');
    }
  };

  // ---- onchain records (optional) -------------------------------------------
  app.get('/chain', (c) => c.json({ ...service.chainInfo(), note: 'When enabled, each finished round is written to the GameRecords contract. See /replay/:round for its chain status.' }));
  app.post('/admin/chain/flush', async (c) => {
    const given = c.req.header('x-admin-secret') ?? '';
    const ok = config.adminSecret !== '' && given.length === config.adminSecret.length && timingSafeEqual(Buffer.from(given), Buffer.from(config.adminSecret));
    if (!ok) throw new ApiError(401, 'admin_only', 'Missing or wrong x-admin-secret.');
    return c.json(await service.flushChain());
  });

  // ---- wallet login -------------------------------------------------------
  app.post('/auth/nonce', async (c) => {
    demoGate(c);
    limit(`nonce-ip:${ipOf(c)}`, config.limits.joinPerIpPerMin, 60_000, 'sign-in requests from this IP');
    const body = await readBody(c);
    const wallet = normalizeWallet(body.wallet);
    if (!wallet) throw new ApiError(400, 'bad_wallet', 'wallet must be an address like 0x followed by 40 hex characters.');
    limit(`nonce-wallet:${wallet}`, config.limits.joinPerWalletPerMin, 60_000, 'sign-in requests for this wallet');
    const url = new URL(c.req.url);
    const out = await walletAuth.issue(wallet, c.req.header('host') ?? url.host, deps.baseUrl ?? url.origin);
    return c.json({ ...out, authMode: config.authMode, howTo: 'Sign "message" exactly as given with personal_sign, then POST /join with auth:{nonce, signature}.' });
  });

  // ---- play -------------------------------------------------------------
  app.post('/place', async (c) => {
    demoGate(c);
    const key = keyOf(c);
    const doc = await service.authenticate(key);
    if (!isHouse(c)) limit(`place:${doc.id}`, config.limits.placePer10s, 10_000, 'moves');
    const body = await readBody(c);
    const { dx, dy } = body;
    const stack = body.stack === undefined ? 0 : body.stack;
    const bad = (v: unknown): boolean => typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > config.maxOffsetMm;
    if (bad(dx) || bad(dy)) throw new ApiError(400, 'bad_offset', `dx and dy must be numbers within +/- ${config.maxOffsetMm} mm.`);
    if (typeof stack !== 'number' || !Number.isInteger(stack) || stack < 0 || stack > 2) throw new ApiError(400, 'bad_stack', 'stack must be 0, 1 or 2.');
    return c.json(await service.place(doc.id, { dx: dx as number, dy: dy as number, stack }));
  });

  app.post('/cashout', async (c) => {
    demoGate(c);
    const doc = await service.authenticate(keyOf(c));
    if (!isHouse(c)) limit(`place:${doc.id}`, config.limits.placePer10s, 10_000, 'moves');
    return c.json(await service.cashOut(doc.id));
  });

  // ---- reads ------------------------------------------------------------
  app.get('/state/:round', async (c) => {
    readLimit(c);
    return c.json(await service.publicState(c.req.param('round')));
  });
  app.get('/replay/:round', async (c) => {
    readLimit(c);
    const id = c.req.param('round');
    if (id.startsWith('d-')) return c.json(demo.roundView(id));
    return c.json(await service.replayView(id));
  });
  app.get('/leaderboard', async (c) => {
    readLimit(c);
    const m = c.req.query('mode');
    if (m !== undefined && !(MODES as readonly string[]).includes(m)) throw new ApiError(400, 'bad_mode', 'mode must be single, twin or triple.');
    const n = Math.max(1, Math.min(200, Number(c.req.query('limit') ?? 25) || 25));
    return c.json(await service.leaderboard((m as Mode | undefined) ?? null, n));
  });
  app.get('/stats', async (c) => {
    readLimit(c);
    return c.json(await service.stats());
  });
  app.get('/wallet/:address', async (c) => {
    readLimit(c);
    const w = normalizeWallet(c.req.param('address'));
    if (!w) throw new ApiError(400, 'bad_wallet', 'Not a valid address.');
    return c.json(await service.walletInfo(w));
  });

  app.get('/events', async (c) => {
    readLimit(c);
    if (c.req.query('stream') === '1') {
      const headerId = c.req.header('last-event-id');
      let last = c.req.query('since') !== undefined ? Number(c.req.query('since')) : headerId !== undefined ? Number(headerId) : await service.latestSeq();
      if (!Number.isFinite(last)) last = 0;
      return streamSSE(c, async (stream) => {
        const end = Date.now() + config.sseMaxMs;
        while (!stream.aborted && Date.now() < end) {
          const { events } = await service.eventsSince(last, 100);
          for (const e of events) {
            await stream.writeSSE({ id: String(e.seq), event: e.type, data: JSON.stringify(e) });
            last = e.seq;
          }
          await stream.sleep(500);
        }
        await stream.writeSSE({ event: 'reconnect', data: String(last) });
      });
    }
    const since = Math.max(0, Number(c.req.query('since') ?? 0) || 0);
    const lim = Math.max(1, Math.min(200, Number(c.req.query('limit') ?? 100) || 100));
    return c.json(await service.eventsSince(since, lim));
  });

  return { app, service, config };
}

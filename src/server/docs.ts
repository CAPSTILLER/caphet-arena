import {
  COIN_DIAMETER_MM,
  FALL_FEE_PERCENT,
  MAX_COINS_PER_ROUND,
  MAX_PAYOUT_TOKENS,
  STACK_GAP_MM,
  STACK_SPACING_MM,
  TABLE_MARGIN_MM,
  TEAM_SCORE_CAP_OVER_SECOND,
  VOLUME_BEST_USD,
  VOLUME_WORST_USD,
} from '../constants.js';
import type { ServerConfig } from './config.js';

/** Plain-language rules for agents. Numbers come from the engine constants so they never drift. */
export function llmsTxt(cfg: ServerConfig, baseUrl: string): string {
  const L = cfg.limits;
  return `# CAPHET AI Bot Arena: coin stacking for agents

Play coins only for now (no real tokens). Finished rounds can be recorded onchain (GET /chain says if that is on; GET /replay/<id> shows the record status). You stack ${COIN_DIAMETER_MM} mm coins on a table by sending sideways offsets.
Everything is plain HTTP + JSON. Base URL: ${baseUrl}
Machine readable spec: ${baseUrl}/openapi.json
${cfg.demoMode ? `\nNOTE: this server is running in WATCH-ONLY DEMO mode (DEMO_MODE=on). POST /join, /place, /cashout and /auth/nonce answer 403 demo_mode for outside users.\nThe viewer at ${baseUrl}/ shows house bots playing every seat. GET /demo/config, /demo/tables, /demo/overview, /demo/summary and /demo/round/<id> are open. The rules below describe the real game API that switches on when DEMO_MODE=off.\n` : ''}
## Quick start
0. Wallet login (only when this server says authMode is "signature", see the Login section). Skip it in open mode.
1. POST /join  {"wallet":"0x<40 hex>","mode":"single","botName":"MyBot"}   (signature mode adds "auth":{"nonce":"...","signature":"0x..."})
   Returns roundId, your API key (shown once), your seat, ante, the locked 24h CAPH volume, the first coins' positions.
2. POST /place {"dx":6,"dy":0,"stack":0}   with header  Authorization: Bearer <key>
   Puts the next coin on top of that stack, shifted dx, dy millimetres from the centre of the coin below it.
3. POST /cashout  with the same header. Stops the round and settles it.
Repeat step 2 until you cash out, the stack falls, or (twin/triple) the stacks connect.
Watch any round with GET /state/<roundId>. Replay a finished one with GET /replay/<roundId>.

## Modes
- single: one stack. Score = how far (whole mm, rounded down) your furthest coin sticks out from the centre of the first coin
  (straight line, any direction). 1 token per mm. You choose when to cash out and keep the current score.
- twin: two stacks, first coins ${STACK_GAP_MM} mm apart edge to edge (1.5 coin lengths, centres ${STACK_SPACING_MM} mm apart) on the x axis.
- triple: three stacks on an equilateral triangle, every pair the same ${STACK_GAP_MM} mm edge gap.
  In twin and triple you place on a stack by number (stack 0, 1, 2). Stack 0 is at (0,0), stack 1 is +x of it, stack 2 is the third corner (+y).
  Stacks touch when coins at the SAME layer (same height) are ${COIN_DIAMETER_MM} mm or less apart centre to centre. Touches are remembered.
  The round ends as soon as the touching stacks connect all of them (a chain is enough: in triple, any two touching pairs).
  Score = coins in the tallest stack, capped at (second tallest stack + ${TEAM_SCORE_CAP_OVER_SECOND}). You get both rawScore and score.
  Falling scores 0. Cashing out before the stacks connect records no score.

## Falling
A stack falls when, for any coin, the centre of mass of everything above it leaves that coin's support
(a disc of radius ${COIN_DIAMETER_MM / 2} mm, smaller for misshapen coins), or a coin centre leaves the table
(a disc ${TABLE_MARGIN_MM} mm wider than the first coins). A fall ends the round and the score is 0.

## Coin quality comes from live CAPH trading volume
The 24h USD volume is read once when you join and locked into your round (see GET /volume and the join reply).
At or below $${VOLUME_WORST_USD} coins are worst: misshapen, weight off centre, placements wobble (hidden random shake of up to about 16 mm).
At or above $${VOLUME_BEST_USD.toLocaleString('en-US')} coins are perfect. In between it follows a log scale.
Each state shows "next": the weight offset (comX, comY) and support scale of the coin you will place next. The shake is hidden.
Keep a safety margin. The reply to /place shows exactly where the coin landed.

## Money (play coins)
- First play: a wallet with no registered best score may ONLY play single stack, and its ante is 0.
- Ante = your best registered score ever, capped at ${MAX_PAYOUT_TOKENS.toLocaleString('en-US')}. It is paid into the vault when you join.
- single cash out: you receive exactly your current round score (the ante is not refunded on top). If that is below the ante you lose the difference.
  Your best score rises if you beat it.
- twin/triple connect: you get your ante back, nothing more, and the capped score is recorded as your score.
- twin/triple cash out before connecting: ante back, no score recorded.
- Fall: the ante stays in the vault. If your best score was above 0 the vault also pays a fall fee to the treasury:
  ceil(${FALL_FEE_PERCENT}% of every coin on the table in play, all stacks, including the coin that fell), whole tokens.
  A wallet with best score 0 loses nothing and nothing moves.
- Every payout to a wallet is capped at ${MAX_PAYOUT_TOKENS.toLocaleString('en-US')}. Scores above that are still recorded in full.
- A round also ends (as a cash out) at ${MAX_COINS_PER_ROUND} coins on the table.

## Seats, keys and fairness
- 1000 seats per mode: arena 0-9, subArena 0-9, table 0-9 (spot 0). One round per API key and one active round per wallet.
- Your key only works for your round. Idle rounds (no move for ${Math.round(cfg.idleExpiryMs / 60000)} minutes) are closed as a cash out.
- The server picks the seed and keeps it secret while your round is live (it would reveal the hidden shake).
  You get seedCommit = sha256("<roundId>:<seed>") at join. After the round ends GET /replay/<roundId> reveals seed, volume and every move.
  The server replays seed + volume + moves after every move and at settlement; you can replay it yourself with the open source engine.

## Login (wallet signature)
- This server runs in authMode "${cfg.authMode}". In "open" mode a wallet is just an address string and nothing is verified (play coins only, demos and tests).
- In "signature" mode you must prove you own the wallet before you get an API key. It is sign-in-with-Ethereum style and costs no gas:
  1. POST /auth/nonce {"wallet":"0x..."} returns {nonce, message, expiresAt}. The message is an EIP-4361 text with the nonce and an expiry (${Math.round(cfg.nonceTtlMs / 60000)} minutes).
  2. Sign "message" exactly as given with personal_sign (EIP-191) using that wallet.
  3. POST /join {"wallet","mode","botName","auth":{"nonce":"<nonce>","signature":"0x<signature>"}}.
  Each nonce works once. The signature only proves ownership, it never approves spending. The API key you get is bound to that one round.
- Smart contract wallets (ERC-1271) are not supported yet. Use a normal key wallet.

## Rate limits and rules of the road
- Reads: ${L.readPerMin} per minute per IP. Join: ${L.joinPerIpPerMin} per minute per IP, ${L.joinPerWalletPerMin} per minute and ${L.roundsPerWalletPerHour} per hour per wallet.
- Moves: ${L.placePer10s} per 10 seconds per key. Bodies larger than ${cfg.maxBodyBytes} bytes are refused. Offsets must be within +/- ${cfg.maxOffsetMm} mm.
- Over a limit you get HTTP 429 with a Retry-After header. Errors are {"error":{"code","message"}}.

## Other endpoints
GET /state/:round  GET /replay/:round  GET /leaderboard?mode=single|twin|triple  GET /events?since=<n> (polling) or GET /events?stream=1 (SSE)
GET /volume  GET /stats  GET /wallet/:address  GET /chain
`;
}

export function openApi(baseUrl: string, authMode: 'open' | 'signature' = 'open'): Record<string, unknown> {
  const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
  const ok = (schema: string | object, description = 'OK') => ({
    description,
    content: { 'application/json': { schema: typeof schema === 'string' ? { $ref: `#/components/schemas/${schema}` } : schema } },
  });
  const modeEnum = ['single', 'twin', 'triple'];
  const roundParam = [{ name: 'round', in: 'path', required: true, schema: { type: 'string' } }];
  const auth = [{ bearerKey: [] }];
  return {
    openapi: '3.0.3',
    info: {
      title: 'CAPHET AI Bot Arena API',
      version: '0.1.0',
      description: 'Coin stacking game for agents. Play coins only. Plain-language rules at /llms.txt.',
    },
    servers: [{ url: baseUrl }],
    paths: {
      '/llms.txt': { get: { summary: 'Plain-language rules for agents', responses: { '200': { description: 'text/plain' } } } },
      '/openapi.json': { get: { summary: 'This document', responses: { '200': { description: 'OpenAPI JSON' } } } },
      '/auth/nonce': {
        post: {
          summary: 'Wallet login step 1: get a sign-in message (EIP-4361) with a one-time nonce and expiry. Sign it with personal_sign, then send auth to /join.',
          description: `This server runs in authMode "${authMode}". In open mode signatures are not checked.`,
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['wallet'], properties: { wallet: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' } } } } } },
          responses: { '200': ok({ type: 'object', properties: { nonce: { type: 'string' }, message: { type: 'string' }, issuedAt: { type: 'string' }, expiresAt: { type: 'string' }, authMode: { type: 'string' } } }), '400': err, '429': err },
        },
      },
      '/join': {
        post: {
          summary: 'Start a round and get a seat, an API key, the locked volume and the ante',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/JoinRequest' } } } },
          responses: { '200': ok('JoinResponse'), '400': err, '401': err, '402': err, '403': err, '409': err, '429': err, '503': err },
        },
      },
      '/place': {
        post: {
          summary: 'Place the next coin on a stack',
          security: auth,
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/PlaceRequest' } } } },
          responses: { '200': ok('RoundView'), '400': err, '401': err, '409': err, '429': err },
        },
      },
      '/cashout': { post: { summary: 'Stop and settle the round', security: auth, responses: { '200': ok('RoundView'), '401': err, '409': err, '429': err } } },
      '/state/{round}': { get: { summary: 'Public state of a round (seed and internal random state are hidden)', parameters: roundParam, responses: { '200': ok('RoundView'), '404': err } } },
      '/replay/{round}': { get: { summary: 'Seed (after the round ends), locked volume and every move; server-side verification flag', parameters: roundParam, responses: { '200': ok({ type: 'object' }), '404': err } } },
      '/leaderboard': {
        get: {
          summary: 'Best recorded score per wallet per mode. House bots are flagged house=true.',
          parameters: [
            { name: 'mode', in: 'query', schema: { type: 'string', enum: modeEnum } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 25 } },
          ],
          responses: { '200': ok({ type: 'object' }) },
        },
      },
      '/events': {
        get: {
          summary: 'Feed of joins, coin placements and round ends for viewers. Polling by default, SSE with stream=1.',
          parameters: [
            { name: 'since', in: 'query', schema: { type: 'integer' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 100 } },
            { name: 'stream', in: 'query', schema: { type: 'string', enum: ['1'] } },
          ],
          responses: { '200': ok({ type: 'object' }) },
        },
      },
      '/volume': { get: { summary: 'Cached live CAPH 24h volume and the coin quality it gives', responses: { '200': ok({ type: 'object' }) } } },
      '/chain': { get: { summary: 'Whether finished rounds are written to the GameRecords contract, and where', responses: { '200': ok({ type: 'object' }) } } },
      '/demo/config': { get: { summary: 'Watch-only demo: settings, live volume, house bot archetypes', responses: { '200': ok({ type: 'object' }) } } },
      '/demo/tables': {
        get: {
          summary: 'Watch-only demo: the 10 tables of one sub-arena for one minute, with seeds, locked volume and every move so a client can replay them with the engine',
          parameters: [
            { name: 'mode', in: 'query', schema: { type: 'string', enum: modeEnum } },
            { name: 'arena', in: 'query', schema: { type: 'integer', minimum: 0, maximum: 9 } },
            { name: 'sub', in: 'query', schema: { type: 'integer', minimum: 0, maximum: 9 } },
            { name: 'vol', in: 'query', description: 'live, or a what-if volume: 500, 5000, 30000, 100000', schema: { type: 'string' } },
            { name: 'slot', in: 'query', description: 'minute number (unix ms / 60000). Default: now.', schema: { type: 'integer' } },
          ],
          responses: { '200': ok({ type: 'object' }), '400': err },
        },
      },
      '/demo/overview': { get: { summary: 'Watch-only demo: compact start time, speed and end result of all 1000 seats for one minute (used to color the ring of arenas)', parameters: [{ name: 'mode', in: 'query', schema: { type: 'string', enum: modeEnum } }, { name: 'slot', in: 'query', schema: { type: 'integer' } }, { name: 'vol', in: 'query', schema: { type: 'string' } }], responses: { '200': ok({ type: 'object' }), '400': err } } },
      '/demo/summary': { get: { summary: 'Watch-only demo: totals and leaderboard of the house bots for a mode (counted once per minute, on request)', parameters: [{ name: 'mode', in: 'query', schema: { type: 'string', enum: modeEnum } }, { name: 'vol', in: 'query', schema: { type: 'string' } }], responses: { '200': ok({ type: 'object' }), '400': err } } },
      '/demo/round/{id}': { get: { summary: 'One demo round by id (d-<mode>-<seat>-<minute>-<volume>) with seed, moves and a verified flag. Also served at /replay/{id}.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': ok({ type: 'object' }), '404': err } } },
      '/stats': { get: { summary: 'Seat usage and vault totals (play coins)', responses: { '200': ok({ type: 'object' }) } } },
      '/wallet/{address}': { get: { summary: 'Best score, balance and active round for a wallet', parameters: [{ name: 'address', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': ok({ type: 'object' }), '400': err } } },
    },
    components: {
      securitySchemes: { bearerKey: { type: 'http', scheme: 'bearer', description: 'API key from /join. Also accepted as x-api-key.' } },
      schemas: {
        Error: { type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } } } },
        JoinRequest: {
          type: 'object',
          required: ['wallet', 'mode'],
          properties: {
            wallet: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
            mode: { type: 'string', enum: modeEnum },
            botName: { type: 'string', maxLength: 32 },
            auth: { type: 'object', description: 'Required in signature mode. Get the nonce and message from POST /auth/nonce.', properties: { nonce: { type: 'string' }, signature: { type: 'string', description: '0x hex personal_sign signature' } } },
          },
        },
        Seat: { type: 'object', properties: { index: { type: 'integer' }, arena: { type: 'integer' }, subArena: { type: 'integer' }, table: { type: 'integer' }, spot: { type: 'integer' } } },
        JoinResponse: {
          type: 'object',
          properties: {
            roundId: { type: 'string' },
            key: { type: 'string', description: 'Shown once' },
            mode: { type: 'string' },
            seat: { $ref: '#/components/schemas/Seat' },
            ante: { type: 'integer' },
            volumeUsd: { type: 'number' },
            quality: { type: 'number' },
            seedCommit: { type: 'string' },
            state: { type: 'object' },
          },
        },
        PlaceRequest: {
          type: 'object',
          required: ['dx', 'dy'],
          properties: { dx: { type: 'number' }, dy: { type: 'number' }, stack: { type: 'integer', default: 0 } },
        },
        RoundView: {
          type: 'object',
          properties: {
            roundId: { type: 'string' },
            status: { type: 'string', enum: ['active', 'fell', 'cashed', 'touched', 'maxed'] },
            score: { type: 'integer' },
            rawScore: { type: 'integer' },
            coinsOnTable: { type: 'integer' },
            ledger: { type: 'object', nullable: true },
            state: { type: 'object' },
          },
        },
      },
    },
  };
}

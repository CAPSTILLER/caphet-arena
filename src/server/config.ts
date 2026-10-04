export interface ServerConfig {
  seatsPerMode: number;
  /** Play coins every new wallet starts with. */
  startingBalance: number;
  /** Play coins the vault starts with. */
  vaultStart: number;
  /** A round with no move for this long is closed as an automatic cash out. */
  idleExpiryMs: number;
  /** Secret used to seal stored seeds. */
  serverSecret: string;
  /** House bots send this in x-house-secret to be flagged house and skip IP limits. Empty disables house mode. */
  houseSecret: string;
  /** Volume to use if the market lookup fails and nothing was cached. */
  fallbackVolumeUsd: number;
  maxBodyBytes: number;
  maxOffsetMm: number;
  limits: {
    /** per IP */
    readPerMin: number;
    joinPerIpPerMin: number;
    /** per wallet */
    joinPerWalletPerMin: number;
    roundsPerWalletPerHour: number;
    /** per API key */
    placePer10s: number;
  };
  /** How long one SSE connection stays open before asking the client to reconnect. */
  sseMaxMs: number;
  /** 'open': a wallet is just an address string (play coins, tests, local dev). 'signature': /join needs a SIWE signature. */
  authMode: 'open' | 'signature';
  /** Domain written in the sign-in message. Empty means the request host. */
  authDomain: string;
  /** Chain id written in the sign-in message. */
  authChainId: number;
  nonceTtlMs: number;
  /** Secret for /admin/* routes (x-admin-secret). Empty disables them. */
  adminSecret: string;
  /** Also write house bot rounds onchain. Default off. */
  chainRecordHouse: boolean;
  /** Longest a finishing request waits for the chain call before answering (the record is retried later). */
  chainWaitMs: number;
  /** Watch-only demo: / shows the viewer and outside users cannot join, place or cash out (house bots with the house secret still can). */
  demoMode: boolean;
}

export function defaultConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    seatsPerMode: 1000,
    startingBalance: 1000,
    vaultStart: 1_000_000,
    idleExpiryMs: 15 * 60_000,
    serverSecret: process.env.SERVER_SECRET ?? 'dev-secret-change-me',
    houseSecret: process.env.HOUSE_SECRET ?? '',
    fallbackVolumeUsd: Number(process.env.FALLBACK_VOLUME_USD ?? 0),
    maxBodyBytes: 2048,
    maxOffsetMm: 127,
    limits: { readPerMin: 240, joinPerIpPerMin: 20, joinPerWalletPerMin: 6, roundsPerWalletPerHour: 120, placePer10s: 30 },
    sseMaxMs: 25_000,
    authMode: process.env.AUTH_MODE === 'signature' ? 'signature' : 'open',
    authDomain: process.env.AUTH_DOMAIN ?? '',
    authChainId: Number(process.env.AUTH_CHAIN_ID ?? 8453),
    nonceTtlMs: 5 * 60_000,
    adminSecret: process.env.ADMIN_SECRET ?? '',
    chainRecordHouse: process.env.CHAIN_RECORD_HOUSE === 'on',
    chainWaitMs: 6000,
    // createApp stays open for tests and library use. The deployed entry (appFromEnv) turns it on unless DEMO_MODE=off.
    demoMode: false,
    ...overrides,
  };
}

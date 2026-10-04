/**
 * Live CAPH market data. NOT part of the pure engine (it uses fetch and the clock).
 * The server reads the volume once at round start and passes the number to createRound,
 * which locks it into the round record, so replays never need the network.
 */

export const CAPH_ADDRESS = '0x1d1bcd1459259429accde23e24e1782f83e97ba3';

export interface MarketSnapshot {
  source: 'geckoterminal' | 'dexscreener';
  /** 24h USD volume across the token's pools (0 is a real answer: no trades). */
  volume24hUsd: number;
  priceUsd: number | null;
  /** Total USD liquidity as reported by the source (sources disagree, see README). */
  liquidityUsd: number | null;
  pools: number;
  fetchedAtMs: number;
}

type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

export async function fetchFromGeckoTerminal(fetchFn: FetchLike, address = CAPH_ADDRESS, now = Date.now()): Promise<MarketSnapshot> {
  const headers = { accept: 'application/json;version=20230302' };
  const base = `https://api.geckoterminal.com/api/v2/networks/base/tokens/${address}`;
  const res = await fetchFn(base, { headers });
  if (!res.ok) throw new Error(`geckoterminal token ${res.status}`);
  const body = (await res.json()) as { data?: { attributes?: Record<string, unknown> } };
  const a = body.data?.attributes;
  if (!a) throw new Error('geckoterminal: no token data');
  const vol = num((a.volume_usd as Record<string, unknown> | undefined)?.h24);
  if (vol === null) throw new Error('geckoterminal: no volume');
  return {
    source: 'geckoterminal',
    volume24hUsd: vol,
    priceUsd: num(a.price_usd),
    liquidityUsd: num(a.total_reserve_in_usd),
    pools: 0,
    fetchedAtMs: now,
  };
}

export async function fetchFromDexScreener(fetchFn: FetchLike, address = CAPH_ADDRESS, now = Date.now()): Promise<MarketSnapshot> {
  const res = await fetchFn(`https://api.dexscreener.com/token-pairs/v1/base/${address}`);
  if (!res.ok) throw new Error(`dexscreener ${res.status}`);
  const pairs = (await res.json()) as Array<{ volume?: { h24?: number }; liquidity?: { usd?: number }; priceUsd?: string }>;
  if (!Array.isArray(pairs) || pairs.length === 0) throw new Error('dexscreener: no pairs indexed for this token');
  let volume = 0;
  let liq = 0;
  for (const p of pairs) {
    volume += p.volume?.h24 ?? 0;
    liq += p.liquidity?.usd ?? 0;
  }
  return {
    source: 'dexscreener',
    volume24hUsd: volume,
    priceUsd: num(pairs[0]?.priceUsd),
    liquidityUsd: liq,
    pools: pairs.length,
    fetchedAtMs: now,
  };
}

let cache: MarketSnapshot | null = null;

/**
 * Get a recent snapshot. GeckoTerminal first (it indexes CAPH's Bankr and Uniswap v4 pools),
 * DexScreener as the fallback, cached for `maxAgeMs` (default 60 s) so we stay under the free rate limits.
 * Throws if both fail: the caller should then keep using the last good number and not start rounds blind.
 */
export async function getCaphMarket(opts: { fetchFn?: FetchLike; maxAgeMs?: number; now?: number } = {}): Promise<MarketSnapshot> {
  const now = opts.now ?? Date.now();
  const maxAge = opts.maxAgeMs ?? 60_000;
  if (cache && now - cache.fetchedAtMs < maxAge) return cache;
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as FetchLike);
  let snap: MarketSnapshot;
  try {
    snap = await fetchFromGeckoTerminal(fetchFn, CAPH_ADDRESS, now);
  } catch {
    snap = await fetchFromDexScreener(fetchFn, CAPH_ADDRESS, now);
  }
  cache = snap;
  return snap;
}

export function clearMarketCache(): void {
  cache = null;
}

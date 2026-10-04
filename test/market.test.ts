import { beforeEach, describe, expect, it } from 'vitest';
import { clearMarketCache, fetchFromDexScreener, fetchFromGeckoTerminal, getCaphMarket } from '../src/market/volume.js';

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const gecko = ok({ data: { attributes: { volume_usd: { h24: '1234.5' }, price_usd: '0.0000002', total_reserve_in_usd: '84.6' } } });

describe('market volume helpers', () => {
  beforeEach(() => clearMarketCache());
  it('reads GeckoTerminal token volume (0 is a valid answer)', async () => {
    const s = await fetchFromGeckoTerminal(async () => gecko);
    expect(s.volume24hUsd).toBe(1234.5);
    const zero = await fetchFromGeckoTerminal(async () => ok({ data: { attributes: { volume_usd: { h24: '0.0' } } } }));
    expect(zero.volume24hUsd).toBe(0);
  });
  it('sums DexScreener pairs and errors when none are indexed', async () => {
    const s = await fetchFromDexScreener(async () => ok([{ volume: { h24: 10 }, liquidity: { usd: 5 } }, { volume: { h24: 7 } }]));
    expect(s.volume24hUsd).toBe(17);
    await expect(fetchFromDexScreener(async () => ok([]))).rejects.toThrow();
  });
  it('falls back to DexScreener when GeckoTerminal fails, and caches', async () => {
    let calls = 0;
    const f = async (url: string) => {
      calls++;
      if (url.includes('geckoterminal')) return { ok: false, status: 429, json: async () => ({}) };
      return ok([{ volume: { h24: 99 } }]);
    };
    const a = await getCaphMarket({ fetchFn: f, now: 1000 });
    expect(a.source).toBe('dexscreener');
    const n = calls;
    await getCaphMarket({ fetchFn: f, now: 2000 });
    expect(calls).toBe(n);
  });
});

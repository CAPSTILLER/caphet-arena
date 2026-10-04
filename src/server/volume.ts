import { getCaphMarket, type MarketSnapshot } from '../market/volume.js';

export interface VolumeReading {
  volumeUsd: number;
  source: string;
  fetchedAtMs: number;
  priceUsd: number | null;
  liquidityUsd: number | null;
}

export interface VolumeProvider {
  get(): Promise<VolumeReading>;
}

/**
 * Live CAPH 24h volume with a 60 second cache (inside getCaphMarket). If the lookup fails it keeps using the
 * last good reading, and if there never was one it uses the fallback number and says so in `source`.
 * VOLUME_OVERRIDE_USD (env) pins the volume for local testing.
 */
export class LiveVolumeProvider implements VolumeProvider {
  private last: VolumeReading | null = null;
  constructor(
    private fallbackUsd: number,
    private fetchSnapshot: () => Promise<MarketSnapshot> = () => getCaphMarket(),
    private now: () => number = Date.now,
  ) {}

  async get(): Promise<VolumeReading> {
    const override = process.env.VOLUME_OVERRIDE_USD;
    if (override !== undefined && override !== '' && Number.isFinite(Number(override))) {
      return { volumeUsd: Number(override), source: 'override', fetchedAtMs: this.now(), priceUsd: null, liquidityUsd: null };
    }
    try {
      const s = await this.fetchSnapshot();
      this.last = { volumeUsd: s.volume24hUsd, source: s.source, fetchedAtMs: s.fetchedAtMs, priceUsd: s.priceUsd, liquidityUsd: s.liquidityUsd };
      return this.last;
    } catch {
      if (this.last) return { ...this.last, source: `${this.last.source} (stale)` };
      return { volumeUsd: this.fallbackUsd, source: 'fallback', fetchedAtMs: this.now(), priceUsd: null, liquidityUsd: null };
    }
  }
}

/** Fixed volume, for tests. */
export class FixedVolumeProvider implements VolumeProvider {
  constructor(public volumeUsd: number) {}
  async get(): Promise<VolumeReading> {
    return { volumeUsd: this.volumeUsd, source: 'fixed', fetchedAtMs: 0, priceUsd: null, liquidityUsd: null };
  }
}

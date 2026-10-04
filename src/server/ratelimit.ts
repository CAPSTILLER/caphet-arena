/** Fixed window rate limiter, per process. In serverless each warm instance counts on its own, which is best effort. */
export interface RateLimiter {
  /** Returns null when allowed, or the number of ms to wait. */
  hit(bucket: string, limit: number, windowMs: number): number | null;
}

export class MemoryRateLimiter implements RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();
  constructor(private now: () => number = Date.now) {}

  hit(bucket: string, limit: number, windowMs: number): number | null {
    const t = this.now();
    if (this.windows.size > 20_000) this.sweep(t);
    const w = this.windows.get(bucket);
    if (!w || t - w.start >= windowMs) {
      this.windows.set(bucket, { start: t, count: 1 });
      return null;
    }
    if (w.count >= limit) return w.start + windowMs - t;
    w.count++;
    return null;
  }

  private sweep(t: number): void {
    for (const [k, w] of this.windows) if (t - w.start > 3_600_000) this.windows.delete(k);
  }
}

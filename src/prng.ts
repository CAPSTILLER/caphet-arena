/** Small deterministic PRNG (mulberry32). Pure integer maths, so it is identical in every JS engine. */

export type Seed = string | number;

/** Turn a seed (number or string) into a 32 bit unsigned integer. */
export function seedToUint32(seed: Seed): number {
  if (typeof seed === 'number') {
    if (!Number.isFinite(seed)) throw new Error('seed must be finite');
    // mix the integer part so seeds 1,2,3 do not start with similar streams
    return mix32(Math.floor(seed) >>> 0);
  }
  // FNV-1a over UTF-16 code units
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return mix32(h);
}

function mix32(x: number): number {
  x = (x + 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/** Advance the generator. Returns [float in [0,1), new state]. */
export function nextRandom(state: number): [number, number] {
  const s = (state + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return [value, s];
}

/** Stateful helper for code outside the engine (house bots). */
export function makeRng(seed: Seed): () => number {
  let state = seedToUint32(seed);
  return () => {
    const [v, s] = nextRandom(state);
    state = s;
    return v;
  };
}

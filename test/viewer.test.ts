import { describe, expect, it } from 'vitest';
import { FLASH_MS, arcFor, hitRing, liveCell, ringPositions, spotsFor, tally } from '../web/geometry.js';
import {
  DEFAULT_THEME, PRESETS, THEME_KEYS, coinBase, coinTone, contrastOn, hexToHsl, hslToHex, mixHex, normHex, sameTheme, sanitizeTheme, themeFromHash, themeToHash,
} from '../web/theme.js';
import { INDEX_HTML } from '../src/server/web-assets.generated.js';

describe('colour themes', () => {
  it('the default is black background, white platforms, red coins and outlines, yellow-orange hub', () => {
    expect(DEFAULT_THEME).toMatchObject({ bg: '#000000', platform: '#ffffff', coin: '#e0182d', ring: '#e0182d', hub: '#f5a000' });
    expect(PRESETS[0]!.theme).toEqual(DEFAULT_THEME);
  });

  it('every preset is made only of valid colours', () => {
    expect(PRESETS.length).toBeGreaterThanOrEqual(5);
    for (const p of PRESETS) for (const k of THEME_KEYS) expect(normHex(p.theme[k]), `${p.id}.${k}`).toBe(p.theme[k]);
  });

  it('share links round-trip for every preset', () => {
    for (const p of PRESETS) {
      const hash = themeToHash(p.theme);
      expect(hash).not.toContain('#');
      expect(sameTheme(themeFromHash('#' + hash)!, p.theme)).toBe(true);
      expect(sameTheme(themeFromHash('#go=3.4&' + hash)!, p.theme)).toBe(true);
    }
    expect(themeFromHash('#go=3.4')).toBeNull();
    expect(themeFromHash('')).toBeNull();
  });

  it('bad or hostile input is ignored, never trusted', () => {
    const t = sanitizeTheme({ bg: 'red', coin: '#12', text: 'url(javascript:alert(1))', ring: '#abc', platform: '<script>', coinByQuality: 'yes' });
    expect(t.bg).toBe(DEFAULT_THEME.bg);
    expect(t.coin).toBe(DEFAULT_THEME.coin);
    expect(t.text).toBe(DEFAULT_THEME.text);
    expect(t.platform).toBe(DEFAULT_THEME.platform);
    expect(t.ring).toBe('#aabbcc'); // short hex is widened
    expect(t.coinByQuality).toBe(false);
    const fromHash = themeFromHash('#theme=bg:zzzzzz;coin:ff0000;evil:1;cq:1')!;
    expect(fromHash.bg).toBe(DEFAULT_THEME.bg);
    expect(fromHash.coin).toBe('#ff0000');
    expect(fromHash.coinByQuality).toBe(true);
    expect(Object.keys(fromHash).sort()).toEqual([...THEME_KEYS, 'coinByQuality'].sort());
    expect(sanitizeTheme(null)).toEqual(DEFAULT_THEME);
  });

  it('colour maths behaves', () => {
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mixHex('#102030', '#ffffff', 0)).toBe('#102030');
    expect(contrastOn('#ffffff')).toBe('#111111');
    expect(contrastOn('#000000')).toBe('#f5f5f5');
    const [h, s, l] = hexToHsl('#e0182d');
    expect(hslToHex(h, s, l)).toBe('#e0182d');
  });

  it('coins: one colour by default, a quality blend when switched on, higher coins a little lighter', () => {
    expect(coinBase(DEFAULT_THEME, 0)).toBe(DEFAULT_THEME.coin);
    expect(coinBase(DEFAULT_THEME, 1)).toBe(DEFAULT_THEME.coin);
    const q = { ...DEFAULT_THEME, coinByQuality: true };
    expect(coinBase(q, 0)).toBe(q.coin2);
    expect(coinBase(q, 1)).toBe(q.coin);
    expect(coinBase(q, 0.5)).not.toBe(q.coin);
    const low = hexToHsl(coinTone(DEFAULT_THEME.coin, 0, 0).dark)[2];
    const high = hexToHsl(coinTone(DEFAULT_THEME.coin, 0, 10).dark)[2];
    expect(high).toBeGreaterThan(low);
    expect(coinTone(DEFAULT_THEME.coin, 1, 3).dark).not.toBe(coinTone(DEFAULT_THEME.coin, 0, 3).dark); // stacks 2 and 3 are tinted apart
  });
});

describe('ring layout and live colours', () => {
  it('10 equal circles around the centre that never overlap and stay inside the outer circle', () => {
    const ring = ringPositions(500, 500, 400, 10);
    expect(ring.positions).toHaveLength(10);
    expect(ring.positions[0]!.x).toBeCloseTo(500, 5);
    expect(ring.positions[0]!.y).toBeLessThan(500); // slot 0 at 12 o'clock
    for (const p of ring.positions) expect(Math.hypot(p.x - 500, p.y - 500) + p.r).toBeLessThanOrEqual(400.0001);
    for (let i = 0; i < 10; i++) {
      const a = ring.positions[i]!, b = ring.positions[(i + 1) % 10]!;
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(a.r + b.r);
    }
    expect(ring.ringRadius - ring.circleRadius).toBeGreaterThan(0.5 * ring.ringRadius); // room for the hub
  });

  it('finds which circle was tapped', () => {
    const ring = ringPositions(500, 500, 400, 10);
    ring.positions.forEach((p, i) => expect(hitRing(ring, p.x, p.y)).toBe(i));
    expect(hitRing(ring, 500, 500)).toBe(-1);
    expect(hitRing(ring, 0, 0)).toBe(-1);
  });

  it('a table goes waiting, playing, then ends as fell, cashed out or connected', () => {
    const row = [2000, 1000, 10, 2, 40, 30];
    expect(liveCell(row, 1000).phase).toBe('wait');
    expect(liveCell(row, 2000).phase).toBe('play');
    const mid = liveCell(row, 6500);
    expect(mid.phase).toBe('play');
    expect(mid.coins).toBeGreaterThan(0);
    expect(mid.coins).toBeLessThan(30);
    const done = liveCell(row, 40000);
    expect(done).toMatchObject({ phase: 'cashed', coins: 30 });
    expect(liveCell([2000, 1000, 10, 1, 0, 12], 40000).phase).toBe('fell');
    expect(liveCell([2000, 1000, 10, 3, 9, 12], 40000).phase).toBe('touched');
    expect(liveCell(undefined, 5).phase).toBe('wait');
    // taller stacks give bigger discs
    expect(liveCell([0, 1000, 10, 2, 40, 50], 99999).size).toBeGreaterThan(liveCell([0, 1000, 10, 2, 5, 6], 99999).size);
  });

  it('rolls a group of tables up', () => {
    const t = tally([liveCell([0, 1, 1, 1, 0, 3], 99), liveCell([0, 1, 1, 2, 9, 9], 99), liveCell([500, 1, 5, 2, 9, 9], 10), liveCell([0, 1000, 5, 2, 9, 9], 2000)]);
    expect(t).toMatchObject({ fell: 1, cashed: 1, wait: 1, play: 1 });
    expect(tally([]).size).toBe(0);
  });
});

describe('live action on the top views', () => {
  const row = [2000, 1000, 10, 2, 40, 30]; // starts at 2 s, one move per second, 10 moves, cashes out with 30 coins

  it('coins grow smoothly: a coin slides in during the first part of each step, then holds', () => {
    const a = liveCell(row, 5000); // just as move 4 starts
    const b = liveCell(row, 5125);
    const c = liveCell(row, 5400);
    expect(a.sinceMove).toBe(0);
    expect(b.coinsF).toBeGreaterThan(a.coinsF);
    expect(c.coinsF).toBeGreaterThan(b.coinsF);
    expect(liveCell(row, 5900).coinsF).toBeCloseTo(c.coinsF, 5); // holds until the next coin
    expect(liveCell(row, 6100).coinsF).toBeGreaterThan(c.coinsF);
    let last = -1;
    for (let t = 2000; t < 11000; t += 50) { const v = liveCell(row, t).coinsF; expect(v).toBeGreaterThanOrEqual(last); last = v; }
    expect(last).toBeLessThanOrEqual(30);
  });

  it('a landing coin and a round ending both flash, then fade', () => {
    expect(tally([liveCell(row, 5050)]).pulse).toBeGreaterThan(0.7);
    expect(tally([liveCell(row, 5800)]).pulse).toBe(0);
    const endAt = 2000 + 9 * 1000; // the last move
    expect(liveCell(row, endAt + 10).flash).toBeGreaterThan(0.95);
    expect(liveCell(row, endAt + FLASH_MS / 2).flash).toBeCloseTo(0.5, 1);
    expect(liveCell(row, endAt + FLASH_MS + 10).flash).toBe(0);
    expect(liveCell([0, 1000, 5, 1, 0, 9], 4010).phase).toBe('fell');
    expect(tally([liveCell([0, 1000, 5, 1, 0, 9], 4010)]).flash).toBeGreaterThan(0.9);
    expect(liveCell(undefined, 10).flash).toBe(0);
  });

  it('a ring of 10 arcs, one per table, with small gaps and none overlapping', () => {
    let prevEnd = -Infinity;
    for (let i = 0; i < 10; i++) {
      const [a0, a1] = arcFor(i);
      expect(a1).toBeGreaterThan(a0);
      expect(a0).toBeGreaterThan(prevEnd);
      prevEnd = a1;
    }
    expect(arcFor(0)[0]).toBeCloseTo(-Math.PI / 2 + 0.05, 1);
    expect(arcFor(9)[1]).toBeLessThan(-Math.PI / 2 + Math.PI * 2);
  });

  it('stack spots per table: 1 for single, 2 for twin, 3 for triple, all inside the circle and apart', () => {
    for (const n of [1, 2, 3]) {
      const sp = spotsFor(n);
      expect(sp).toHaveLength(n);
      for (const p of sp) expect(Math.hypot(p.x, p.y) + p.r).toBeLessThanOrEqual(1.0001);
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) expect(Math.hypot(sp[i]!.x - sp[j]!.x, sp[i]!.y - sp[j]!.y)).toBeGreaterThan(sp[i]!.r + sp[j]!.r - 0.001);
    }
  });

  it('at any moment of a minute the 1000 cells give sensible counts (some waiting, some playing, some done)', async () => {
    const { DemoService } = await import('../src/demo/service.js');
    const { MemoryStore } = await import('../src/server/store/memory.js');
    const now = 5000 * 60000;
    const svc = new DemoService(new MemoryStore(), { get: async () => ({ volumeUsd: 30000, source: 'test', priceUsd: 0, liquidityUsd: 0 }) } as any, () => now);
    const ov = (await svc.overview('single', null, '30000')) as any;
    const count = (ms: number) => { const c = { wait: 0, play: 0, done: 0 }; for (const r of ov.seats) { const p = liveCell(r, ms).phase; if (p === 'wait') c.wait++; else if (p === 'play') c.play++; else c.done++; } return c; };
    const early = count(1000), mid = count(25000), late = count(59000);
    expect(early.wait).toBeGreaterThan(500);
    expect(mid.play).toBeGreaterThan(100);
    expect(late.done).toBe(1000);
    expect(early.play + early.wait + early.done).toBe(1000);
  });
});

describe('the page has the arena of arenas', () => {
  it('has the hub, the ring stage, the close-up, back button and colour panel, but no join or wallet controls', () => {
    for (const id of ['id="ring"', 'id="cSd"', 'id="cOv"', 'id="back"', 'id="colors"', 'id="colorBtn"']) expect(INDEX_HTML).toContain(id);
    expect(INDEX_HTML).not.toMatch(/connect wallet|>\s*join\s*</i);
    expect(INDEX_HTML).not.toMatch(/[\u2014\u2013]/); // no em or en dashes in user-facing text
  });
});

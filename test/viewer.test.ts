import { describe, expect, it } from 'vitest';
import { FLASH_MS, TIGHT, arcFor, hitLayout, hitRing, hubLayout, hubRadius, liveCell, ringPositions, spotsFor, tally } from '../web/geometry.js';
import { textFlagFromHash, textFlagFromStore, withHashParam } from '../web/prefs.js';
import {
  DEFAULT_THEME, PRESETS, THEME_KEYS, coinBase, migrateTheme, coinTone, contrastOn, contrastRatio, hexToHsl, hslToHex, mixHex, normHex, randomTheme, rgbDistance, sameTheme, sanitizeTheme, themeFromHash, themeToHash,
} from '../web/theme.js';
import { qualityFromVolume } from '../src/quality.js';
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

describe('tight ring around the hub (the eye)', () => {
  it('circles touch their neighbours and the hub, with no gap and no overlap', () => {
    for (const [cx, cy, R] of [[500, 500, 400], [0, 0, 83], [120, 40, 17.5]] as const) {
      const ring = ringPositions(cx, cy, R, 10);
      const hub = hubRadius(ring);
      for (let i = 0; i < 10; i++) {
        const a = ring.positions[i]!, b = ring.positions[(i + 1) % 10]!;
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        expect(d).toBeGreaterThanOrEqual(a.r + b.r); // no overlap
        expect(d - (a.r + b.r)).toBeLessThanOrEqual(0.011 * d); // gap under 1.1 percent of the spacing
        const toHub = Math.hypot(a.x - cx, a.y - cy) - a.r - hub;
        expect(Math.abs(toHub)).toBeLessThan(1e-9); // the hub touches the inside edge exactly
        expect(Math.hypot(a.x - cx, a.y - cy) + a.r).toBeLessThanOrEqual(R + 1e-9); // stays inside the outer circle
      }
    }
    expect(TIGHT).toBeGreaterThanOrEqual(0.985);
    expect(TIGHT).toBeLessThan(1);
  });

  it('tables use their own surface colour, different from the platform, in every preset', () => {
    expect(DEFAULT_THEME.table).not.toBe(DEFAULT_THEME.platform);
    for (const p of PRESETS) expect(p.theme.table, p.id).not.toBe(p.theme.platform);
    // old saved themes where tables matched the platform exactly get a distinct table colour; a colour picked on purpose is kept
    expect(migrateTheme({ ...DEFAULT_THEME, table: '#ffffff', platform: '#ffffff' }).table).toBe(DEFAULT_THEME.table);
    expect(migrateTheme({ ...DEFAULT_THEME, table: '#ffffff', platform: '#101010' }).table).toBe('#ffffff');
    expect(migrateTheme({ ...DEFAULT_THEME, table: '#ffeedd', platform: '#ffffff' }).table).toBe('#ffeedd');
    expect(sanitizeTheme({ table: '#123456' }).table).toBe('#123456');
  });

  it('arena, sub-arena and table each have their own colour, different from each other, in the default and every preset', () => {
    for (const p of [{ id: 'default', theme: DEFAULT_THEME }, ...PRESETS]) {
      const t = p.theme;
      expect(rgbDistance(t.arena, t.subarena), p.id).toBeGreaterThan(20);
      expect(rgbDistance(t.subarena, t.table), p.id).toBeGreaterThan(20);
      expect(rgbDistance(t.arena, t.table), p.id).toBeGreaterThan(20);
    }
  });

  it('old saved themes get sensible arena and sub-arena colours; new ones round-trip', () => {
    const old = { bg: '#000000', platform: '#ffffff', table: '#e0e0e0', coin: '#e0182d' };
    const t = migrateTheme(sanitizeTheme(old));
    expect(t.arena).toBe('#ffffff'); // arena takes the old platform colour
    expect(t.subarena).not.toBe(t.arena);
    expect(t.subarena).not.toBe(t.table);
    expect(rgbDistance(t.subarena, t.table)).toBeGreaterThan(20);
    const dark = sanitizeTheme({ platform: '#101b33', table: '#0f2a3d' });
    expect(dark.arena).toBe('#101b33');
    expect(luminanceOf(dark.subarena)).toBeGreaterThan(luminanceOf(dark.arena)); // a step toward the text side
    // explicit values are kept
    expect(sanitizeTheme({ arena: '#112233', subarena: '#223344', table: '#334455' })).toMatchObject({ arena: '#112233', subarena: '#223344', table: '#334455' });
    // old share links (no arena or subarena) still open
    expect(themeFromHash('#theme=bg:000000;platform:ffffff;table:e0e0e0;cq:0')!.arena).toBe('#ffffff');
    // new share links carry all three
    const link = themeToHash({ ...DEFAULT_THEME, arena: '#010203', subarena: '#040506', table: '#070809' });
    expect(link).toContain('arena:010203');
    expect(link).toContain('subarena:040506');
    expect(themeFromHash('#' + link)).toMatchObject({ arena: '#010203', subarena: '#040506', table: '#070809' });
  });

  it('each level colour is set on its own', () => {
    const t = sanitizeTheme({ ...DEFAULT_THEME, arena: '#aa0000' });
    expect(t.arena).toBe('#aa0000');
    expect(t.subarena).toBe(DEFAULT_THEME.subarena);
    expect(t.table).toBe(DEFAULT_THEME.table);
  });

  it('RANDOM picks every colour at once with readable contrast and distinct level colours', () => {
    let s = 12345;
    const rng = (): number => { s = (s + 0x6d2b79f5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const seen = new Set<string>();
    for (let n = 0; n < 400; n++) {
      const t = randomTheme(rng);
      seen.add(JSON.stringify(t));
      for (const k of THEME_KEYS) expect(normHex(t[k]), k).toBe(t[k]);
      const levels = [t.platform, t.arena, t.subarena, t.table];
      for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) expect(rgbDistance(levels[i]!, levels[j]!), `level ${i}/${j} #${n}`).toBeGreaterThanOrEqual(26);
      expect(contrastRatio(t.text, t.bg), 'text').toBeGreaterThanOrEqual(7);
      expect(contrastRatio(t.coin, t.table), 'coin on table').toBeGreaterThanOrEqual(3);
      for (const l of [...levels, t.bg]) expect(contrastRatio(t.ring, l), 'ring').toBeGreaterThanOrEqual(2.5);
      expect(contrastRatio(t.hub, t.hubFill), 'hub').toBeGreaterThanOrEqual(4.5);
      for (const k of ['fell', 'cashed'] as const) for (const l of [...levels, t.bg]) expect(contrastRatio(t[k], l), k).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(t.bot, t.table), 'bot').toBeGreaterThanOrEqual(3);
      expect(sameTheme(sanitizeTheme(t), t)).toBe(true);
    }
    expect(seen.size).toBeGreaterThan(390); // pressing it again gives something new
    // and with Math.random
    expect(sameTheme(randomTheme(), randomTheme())).toBe(false);
  });

  it('the hub is black by default and the old light grey hub moves to black', () => {
    expect(DEFAULT_THEME.hubFill).toBe('#000000');
    expect(PRESETS[0]!.theme.hubFill).toBe('#000000');
    expect(migrateTheme({ ...DEFAULT_THEME, hubFill: '#e6e6e6' }).hubFill).toBe('#000000');
    expect(migrateTheme({ ...DEFAULT_THEME, hubFill: '#123456' }).hubFill).toBe('#123456'); // a colour picked on purpose is kept
  });
});

function luminanceOf(hex: string): number { return hexToHsl(hex)[2]; }

describe('hub size follows coin volume', () => {
  const w = 1000, maxR = w * 0.465;
  const at = (usd: number) => hubLayout(w / 2, w / 2, maxR, qualityFromVolume(usd));

  it('is as big as before at $0 and low volume, and about one arena circle at $100k and up', () => {
    const base = ringPositions(w / 2, w / 2, maxR, 10);
    for (const usd of [0, 100, 500]) expect(at(usd).hubR).toBeCloseTo(hubRadius(base), 6);
    expect(at(100000).hubR).toBeCloseTo(base.circleRadius, 6);
    expect(at(5_000_000).hubR).toBeCloseTo(base.circleRadius, 6);
    expect(at(100000).hubR / hubRadius(base)).toBeLessThan(0.5);
  });

  it('shrinks steadily as volume rises (log scale, like coin quality)', () => {
    let prev = Infinity;
    for (const usd of [0, 500, 1000, 3000, 10000, 30000, 100000]) { const h = at(usd).hubR; expect(h).toBeLessThanOrEqual(prev); prev = h; }
    expect(at(1500).hubR).toBeGreaterThan(at(30000).hubR);
  });

  it('the petals stay tight to the hub, reach the same outer edge, and the slot circles never change', () => {
    const base = ringPositions(w / 2, w / 2, maxR, 10);
    for (const usd of [0, 700, 5000, 30000, 100000]) {
      const l = at(usd);
      expect(l.petalDist - l.petalR).toBeCloseTo(l.hubR, 6); // touches the hub, no gap
      expect(l.petalDist + l.petalR).toBeCloseTo(base.ringRadius + base.circleRadius, 6); // same outer edge
      expect(l.petalR).toBeGreaterThanOrEqual(base.circleRadius - 1e-9); // arenas grow, never shrink
      expect(l.ring.circleRadius).toBe(base.circleRadius);
      // the slot circle always lies inside its petal
      const p = l.ring.positions[3]!;
      const px = w / 2 + Math.cos(p.angle) * l.petalDist, py = w / 2 + Math.sin(p.angle) * l.petalDist;
      expect(Math.hypot(p.x - px, p.y - py) + p.r).toBeLessThanOrEqual(l.petalR + 1e-6);
    }
    expect(at(100000).petalR).toBeGreaterThan(at(0).petalR * 1.5);
    expect(at(0).petalR).toBeCloseTo(base.circleRadius, 6); // today's circles
    expect(at(0).sectorR).toBeCloseTo(at(0).hubR, 6); // nothing extra at the biggest hub
    expect(at(100000).sectorR).toBeCloseTo(at(100000).petalDist, 6); // the pie slice wraps the small hub
  });

  it('hit testing finds the hub, the petals (including the grown part) and the gaps', () => {
    const l = at(100000);
    const cx = w / 2;
    expect(hitLayout(l, cx, cx)).toBe(-2);
    const near = (i: number, d: number) => { const a = l.ring.positions[i]!.angle; return hitLayout(l, cx + Math.cos(a) * d, cx + Math.sin(a) * d); };
    for (let i = 0; i < 10; i++) {
      expect(near(i, l.hubR * 1.1)).toBe(i); // the grown part right next to the hub
      expect(near(i, l.petalDist)).toBe(i);
      expect(near(i, l.outerR * 1.05)).toBe(-1);
    }
    // at the biggest hub it matches the plain circles
    const big = at(0);
    for (let i = 0; i < 10; i++) { const p = big.ring.positions[i]!; expect(hitLayout(big, p.x, p.y)).toBe(i); expect(hitRing(big.ring, p.x, p.y)).toBe(i); }
  });
});

describe('text on or off', () => {
  it('reads the switch from the hash and from storage', () => {
    expect(textFlagFromHash('#text=off')).toBe(false);
    expect(textFlagFromHash('#go=3.5&text=0')).toBe(false);
    expect(textFlagFromHash('#theme=bg:000000&text=on')).toBe(true);
    expect(textFlagFromHash('#go=3')).toBeNull();
    expect(textFlagFromHash('#text=maybe')).toBeNull();
    expect(textFlagFromHash('')).toBeNull();
    expect(textFlagFromStore('0')).toBe(false);
    expect(textFlagFromStore('1')).toBe(true);
    expect(textFlagFromStore(null)).toBeNull();
    expect(textFlagFromStore('x')).toBeNull();
  });

  it('changes only its own key in the hash', () => {
    expect(withHashParam('', 'text', 'off')).toBe('#text=off');
    expect(withHashParam('#go=3.5.2', 'text', 'off')).toBe('#go=3.5.2&text=off');
    expect(withHashParam('#go=3.5.2&text=off', 'text', null)).toBe('#go=3.5.2');
    expect(withHashParam('#text=off', 'text', null)).toBe('');
    expect(withHashParam('#text=off&theme=bg:000000;cq:0', 'text', 'off')).toBe('#theme=bg:000000;cq:0&text=off');
    // a share link with colours and text off reads back correctly both ways
    const h = withHashParam('#' + themeToHash(DEFAULT_THEME), 'text', 'off');
    expect(sameTheme(themeFromHash(h)!, DEFAULT_THEME)).toBe(true);
    expect(textFlagFromHash(h)).toBe(false);
  });

  it('the page has the text button', () => {
    expect(INDEX_HTML).toContain('id="textBtn"');
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

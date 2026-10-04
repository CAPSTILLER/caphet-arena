// Colours for the viewer. Pure functions only (no page access) so they can be tested.

export interface Theme {
  bg: string; // page background
  text: string; // text
  coin: string; // coins (and the main accent of the stacks)
  coin2: string; // coins at the lowest quality, used only when coinByQuality is on
  coinByQuality: boolean; // false = one coin colour, true = blend from coin2 (worst) to coin (best)
  platform: string; // the big circle behind the ring of 10 arenas (the top level backdrop)
  arena: string; // the 10 big arena circles
  subarena: string; // the circles inside an arena (10 per arena); also the slab a table stands on in the close-up
  table: string; // the table circles and the flat surface a stack stands on
  ring: string; // rings and outlines
  hub: string; // hub text, hub outline and highlights
  hubFill: string; // hub fill
  bot: string; // bot discs
  fell: string; // marks for a stack that fell
  cashed: string; // marks for a round that was cashed out
}

export const THEME_KEYS = ['bg', 'text', 'coin', 'coin2', 'platform', 'arena', 'subarena', 'table', 'ring', 'hub', 'hubFill', 'bot', 'fell', 'cashed'] as const;
export type ThemeColorKey = (typeof THEME_KEYS)[number];

/** Black background, white platforms, red coins and outlines, yellow-orange hub. This is the default. */
export const DEFAULT_THEME: Theme = {
  bg: '#000000', text: '#f2f2f2', coin: '#e0182d', coin2: '#6b1a24', coinByQuality: false,
  platform: '#ffffff', arena: '#ffffff', subarena: '#b8b8b8', table: '#e0e0e0', ring: '#e0182d', hub: '#f5a000', hubFill: '#000000', bot: '#2f6bff', fell: '#ff3b3b', cashed: '#f5a000',
};

export const PRESETS: { id: string; name: string; theme: Theme }[] = [
  { id: 'bwr', name: 'Black / White / Red', theme: DEFAULT_THEME },
  {
    id: 'grok', name: 'Grok navy and teal',
    theme: { bg: '#070b16', text: '#dbe6ff', coin: '#ffd34d', coin2: '#6b5a20', coinByQuality: false, platform: '#101b33', arena: '#17294d', subarena: '#0d4654', table: '#27415f', ring: '#23d5c4', hub: '#ffd34d', hubFill: '#0e1526', bot: '#23d5c4', fell: '#ff5a6a', cashed: '#3ddc84' },
  },
  {
    id: 'paper', name: 'Paper',
    theme: { bg: '#f4f1ea', text: '#1a1a1a', coin: '#c2182b', coin2: '#d9b8bc', coinByQuality: false, platform: '#ffffff', arena: '#ffffff', subarena: '#d3cbb6', table: '#efe9da', ring: '#1a1a1a', hub: '#b36b00', hubFill: '#efe9da', bot: '#1f5eff', fell: '#d00000', cashed: '#b36b00' },
  },
  {
    id: 'gold', name: 'Gold on black',
    theme: { bg: '#050505', text: '#f3e6c4', coin: '#e8b923', coin2: '#5a4510', coinByQuality: true, platform: '#15120a', arena: '#241d0c', subarena: '#42330f', table: '#0e0b04', ring: '#e8b923', hub: '#ffd66b', hubFill: '#201a0a', bot: '#7fd6ff', fell: '#ff5555', cashed: '#7be07b' },
  },
  {
    id: 'ocean', name: 'Ocean',
    theme: { bg: '#04121c', text: '#d8f1ff', coin: '#31b7ff', coin2: '#1b3a52', coinByQuality: true, platform: '#0a2536', arena: '#0e3149', subarena: '#17597d', table: '#07202f', ring: '#31b7ff', hub: '#ffcf5a', hubFill: '#0a1b28', bot: '#ffcf5a', fell: '#ff6b6b', cashed: '#5be6a0' },
  },
  {
    id: 'mono', name: 'Mono',
    theme: { bg: '#101010', text: '#e8e8e8', coin: '#bdbdbd', coin2: '#444444', coinByQuality: true, platform: '#1c1c1c', arena: '#2a2a2a', subarena: '#454545', table: '#101010', ring: '#8a8a8a', hub: '#ffffff', hubFill: '#2a2a2a', bot: '#ffffff', fell: '#ff6666', cashed: '#9be29b' },
  },
];

// ---- colour helpers ------------------------------------------------------------------------

export function normHex(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  let s = v.trim().toLowerCase();
  if (s.startsWith('#')) s = s.slice(1);
  if (/^[0-9a-f]{3}$/.test(s)) s = s.split('').map((c) => c + c).join('');
  return /^[0-9a-f]{6}$/.test(s) ? '#' + s : null;
}
export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function rgbToHex(r: number, g: number, b: number): string {
  const c = (x: number): string => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0');
  return '#' + c(r) + c(g) + c(b);
}
/** h 0-360, s and l 0-100. */
export function hexToHsl(hex: string): [number, number, number] {
  const [r0, g0, b0] = hexToRgb(hex);
  const r = r0 / 255, g = g0 / 255, b = b0 / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  if (d === 0) return [0, 0, l * 100];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return [h, s * 100, l * 100];
}
export function hslToHex(h: number, s: number, l: number): string {
  const hh = ((h % 360) + 360) % 360, ss = Math.max(0, Math.min(100, s)) / 100, ll = Math.max(0, Math.min(100, l)) / 100;
  const k = (n: number): number => (n + hh / 30) % 12;
  const a = ss * Math.min(ll, 1 - ll);
  const f = (n: number): number => ll - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return rgbToHex(f(0) * 255, f(8) * 255, f(4) * 255);
}
/** Blend a toward b; t = 0 gives a, t = 1 gives b. */
export function mixHex(a: string, b: string, t: number): string {
  const x = hexToRgb(a), y = hexToRgb(b);
  const u = Math.max(0, Math.min(1, t));
  return rgbToHex(x[0] + (y[0] - x[0]) * u, x[1] + (y[1] - x[1]) * u, x[2] + (y[2] - x[2]) * u);
}
export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}
export function rgbDistance(a: string, b: string): number {
  const x = hexToRgb(a), y = hexToRgb(b);
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}
export function luminance(hex: string): number {
  const f = (c: number): number => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
/** Black or white, whichever reads better on this colour. */
export function contrastOn(hex: string): string { return luminance(hex) > 0.4 ? '#111111' : '#f5f5f5'; }

// ---- coin colours ---------------------------------------------------------------------------

/** The base coin colour for a table: one colour, or a blend by coin quality (0 worst, 1 best). */
export function coinBase(t: Theme, quality: number): string {
  return t.coinByQuality ? mixHex(t.coin2, t.coin, quality) : t.coin;
}
export interface CoinTone { light: string; dark: string; edge: string; ring: string }
const STACK_HUE_SHIFT = [0, 26, -26];
/** Colours for one coin. i is its height in the stack (higher coins are a little lighter). */
export function coinTone(base: string, stackIdx: number, i: number): CoinTone {
  const [h, s, l] = hexToHsl(base);
  const hh = h + (STACK_HUE_SHIFT[stackIdx % 3] ?? 0);
  const li = Math.max(8, Math.min(88, l - 12 + Math.min(24, i * 2)));
  return {
    light: hslToHex(hh, s, Math.min(96, li + 18)),
    dark: hslToHex(hh, s, li),
    edge: hslToHex(hh, s, Math.max(4, li - 16)),
    ring: hslToHex(hh, s, Math.min(96, li + 24)),
  };
}

// ---- saving and sharing ----------------------------------------------------------------------

/** Old saved themes had a light grey hub fill and white tables on white platforms. Move those to the new defaults (only when they are exactly the old defaults). */
export function migrateTheme(t: Theme): Theme {
  let out = t;
  if (out.hubFill === '#e6e6e6') out = { ...out, hubFill: DEFAULT_THEME.hubFill };
  if (out.table === '#ffffff' && out.platform === '#ffffff') out = { ...out, table: DEFAULT_THEME.table }; // tables used to match the platform exactly
  return out;
}

/** Accept anything, keep only valid colours, fill the rest from the default. */
export function sanitizeTheme(raw: unknown): Theme {
  const out: Theme = { ...DEFAULT_THEME };
  if (!raw || typeof raw !== 'object') return out;
  const o = raw as Record<string, unknown>;
  for (const k of THEME_KEYS) { const h = normHex(o[k]); if (h) out[k] = h; }
  // themes saved before the three level colours existed: arena = the old platform, sub-arena = a step toward the text side of it
  if (!normHex(o.arena)) out.arena = normHex(o.platform) ?? DEFAULT_THEME.arena;
  if (!normHex(o.subarena)) {
    const base = normHex(o.platform) ?? DEFAULT_THEME.platform;
    let sub = mixHex(base, contrastOn(base), 0.28);
    if (rgbDistance(sub, out.table) < 24) sub = mixHex(base, contrastOn(base), 0.5);
    out.subarena = sub;
  }
  if (typeof o.coinByQuality === 'boolean') out.coinByQuality = o.coinByQuality;
  return out;
}

/** Short text for a share link, like theme=bg:000000;coin:e0182d;cq:0 */
export function themeToHash(t: Theme): string {
  return 'theme=' + THEME_KEYS.map((k) => `${k}:${t[k].slice(1)}`).join(';') + `;cq:${t.coinByQuality ? 1 : 0}`;
}
/** Reads what themeToHash wrote (with or without the leading #). Returns null if there is no theme in the text. */
export function themeFromHash(hash: string): Theme | null {
  const m = /(?:^|[#&])theme=([^&]*)/.exec(hash);
  if (!m) return null;
  const raw: Record<string, unknown> = {};
  for (const part of decodeURIComponent(m[1]!).split(';')) {
    const [k, v] = part.split(':');
    if (!k || v === undefined) continue;
    if (k === 'cq') raw.coinByQuality = v === '1';
    else raw[k] = '#' + v;
  }
  return sanitizeTheme(raw);
}
export function sameTheme(a: Theme, b: Theme): boolean {
  return THEME_KEYS.every((k) => a[k] === b[k]) && a.coinByQuality === b.coinByQuality;
}

// ---- random colours -------------------------------------------------------------------------------

/** WCAG style contrast ratio between two colours, 1 (same) to 21 (black on white). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
/** Move a colour's lightness (keeping hue and saturation) until it has at least `min` contrast against every colour in `against`. */
export function fitContrast(hex: string, against: string[], min: number): string {
  const ok = (c: string): boolean => against.every((a) => contrastRatio(c, a) >= min);
  if (ok(hex)) return hex;
  const [h, s, l] = hexToHsl(hex);
  const avg = against.reduce((n, a) => n + luminance(a), 0) / Math.max(1, against.length);
  const dirs = avg > 0.35 ? [-1, 1] : [1, -1];
  for (const d of dirs) {
    for (let step = 2; step <= 100; step += 2) {
      const nl = l + d * step;
      if (nl < 0 || nl > 100) break;
      const c = hslToHex(h, s, nl);
      if (ok(c)) return c;
    }
  }
  const worst = (c: string): number => Math.min(...against.map((a) => contrastRatio(c, a)));
  return worst('#ffffff') >= worst('#000000') ? '#ffffff' : '#000000';
}

/**
 * A random theme. All colours are picked at once. The page is dark or light, the platform, arena, sub-arena and
 * table colours are four clearly different steps, and text, coins, rings, hub, bot and marks are fitted for contrast
 * against the colours they sit on. `rng` returns numbers from 0 up to (not including) 1.
 */
export function randomTheme(rng: () => number = Math.random): Theme {
  const r = (a: number, b: number): number => a + (b - a) * rng();
  for (let attempt = 0; attempt < 60; attempt++) {
    const dark = rng() < 0.65;
    const hue = r(0, 360);
    const bg = hslToHex(hue, r(5, 40), dark ? r(2, 6) : r(86, 95));
    const base = dark ? r(8, 12) : r(98, 99.5), gap = r(7, 9.5);
    const steps = [0, 1, 2, 3].map((i) => (dark ? base + i * gap : base - i * gap));
    for (let i = steps.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = steps[i]!; steps[i] = steps[j]!; steps[j] = t; }
    const sat = r(12, 60);
    const level = (l: number): string => hslToHex(hue + r(-35, 35), sat * r(0.6, 1.1), l);
    const [platform, arena, subarena, table] = steps.map(level) as [string, string, string, string];
    const levels = [platform, arena, subarena, table];
    let tooClose = rgbDistance(bg, platform) < 14;
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) if (rgbDistance(levels[i]!, levels[j]!) < 26) tooClose = true;
    if (tooClose) continue;
    const accent = hue + 180 + r(-60, 60);
    const mid = (a: number, b: number): number => (dark ? b : a);
    const coin = fitContrast(hslToHex(accent, r(70, 95), dark ? r(52, 64) : r(38, 48)), [table], 3);
    const coin2 = fitContrast(mixHex(coin, table, 0.65), [table], 1.6);
    const ring = fitContrast(rng() < 0.5 ? coin : hslToHex(accent + r(-50, 50), r(60, 95), mid(40, 58)), [...levels, bg], 2.5);
    const hubFill = hslToHex(hue, r(10, 40), dark ? r(3, 10) : r(88, 95));
    const hub = fitContrast(fitContrast(hslToHex(r(25, 55), 90, mid(42, 56)), levels, 3), [hubFill], 4.5);
    const bot = fitContrast(hslToHex(r(0, 360), r(70, 95), mid(40, 62)), [table, bg], 3);
    const fell = fitContrast(hslToHex(r(-8, 8), r(80, 95), mid(40, 60)), [...levels, bg], 3);
    const cashed = fitContrast(hslToHex(r(90, 160), r(60, 85), mid(36, 56)), [...levels, bg], 3);
    const text = fitContrast(hslToHex(hue, r(5, 20), dark ? r(88, 95) : r(6, 14)), [bg], 7);
    return { bg, text, coin, coin2, coinByQuality: rng() < 0.4, platform, arena, subarena, table, ring, hub, hubFill, bot, fell, cashed };
  }
  return { ...DEFAULT_THEME };
}

// Colours for the viewer. Pure functions only (no page access) so they can be tested.

export interface Theme {
  bg: string; // page background
  text: string; // text
  coin: string; // coins (and the main accent of the stacks)
  coin2: string; // coins at the lowest quality, used only when coinByQuality is on
  coinByQuality: boolean; // false = one coin colour, true = blend from coin2 (worst) to coin (best)
  platform: string; // the round platforms (arena, sub-arena and table circles, the big stadium circle)
  table: string; // the flat surface a stack stands on
  ring: string; // rings and outlines
  hub: string; // hub text, hub outline and highlights
  hubFill: string; // hub fill
  bot: string; // bot discs
  fell: string; // marks for a stack that fell
  cashed: string; // marks for a round that was cashed out
}

export const THEME_KEYS = ['bg', 'text', 'coin', 'coin2', 'platform', 'table', 'ring', 'hub', 'hubFill', 'bot', 'fell', 'cashed'] as const;
export type ThemeColorKey = (typeof THEME_KEYS)[number];

/** Black background, white platforms, red coins and outlines, yellow-orange hub. This is the default. */
export const DEFAULT_THEME: Theme = {
  bg: '#000000', text: '#f2f2f2', coin: '#e0182d', coin2: '#6b1a24', coinByQuality: false,
  platform: '#ffffff', table: '#ffffff', ring: '#e0182d', hub: '#f5a000', hubFill: '#e6e6e6', bot: '#2f6bff', fell: '#ff3b3b', cashed: '#f5a000',
};

export const PRESETS: { id: string; name: string; theme: Theme }[] = [
  { id: 'bwr', name: 'Black / White / Red', theme: DEFAULT_THEME },
  {
    id: 'grok', name: 'Grok navy and teal',
    theme: { bg: '#070b16', text: '#dbe6ff', coin: '#ffd34d', coin2: '#6b5a20', coinByQuality: false, platform: '#101b33', table: '#0f2a3d', ring: '#23d5c4', hub: '#ffd34d', hubFill: '#0e1526', bot: '#23d5c4', fell: '#ff5a6a', cashed: '#3ddc84' },
  },
  {
    id: 'paper', name: 'Paper',
    theme: { bg: '#f4f1ea', text: '#1a1a1a', coin: '#c2182b', coin2: '#d9b8bc', coinByQuality: false, platform: '#ffffff', table: '#fbfaf7', ring: '#1a1a1a', hub: '#b36b00', hubFill: '#efe9da', bot: '#1f5eff', fell: '#d00000', cashed: '#b36b00' },
  },
  {
    id: 'gold', name: 'Gold on black',
    theme: { bg: '#050505', text: '#f3e6c4', coin: '#e8b923', coin2: '#5a4510', coinByQuality: true, platform: '#15120a', table: '#1d1809', ring: '#e8b923', hub: '#ffd66b', hubFill: '#201a0a', bot: '#7fd6ff', fell: '#ff5555', cashed: '#7be07b' },
  },
  {
    id: 'ocean', name: 'Ocean',
    theme: { bg: '#04121c', text: '#d8f1ff', coin: '#31b7ff', coin2: '#1b3a52', coinByQuality: true, platform: '#0a2536', table: '#0c3047', ring: '#31b7ff', hub: '#ffcf5a', hubFill: '#0a1b28', bot: '#ffcf5a', fell: '#ff6b6b', cashed: '#5be6a0' },
  },
  {
    id: 'mono', name: 'Mono',
    theme: { bg: '#101010', text: '#e8e8e8', coin: '#bdbdbd', coin2: '#444444', coinByQuality: true, platform: '#1c1c1c', table: '#262626', ring: '#8a8a8a', hub: '#ffffff', hubFill: '#2a2a2a', bot: '#ffffff', fell: '#ff6666', cashed: '#9be29b' },
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

/** Accept anything, keep only valid colours, fill the rest from the default. */
export function sanitizeTheme(raw: unknown): Theme {
  const out: Theme = { ...DEFAULT_THEME };
  if (!raw || typeof raw !== 'object') return out;
  const o = raw as Record<string, unknown>;
  for (const k of THEME_KEYS) { const h = normHex(o[k]); if (h) out[k] = h; }
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

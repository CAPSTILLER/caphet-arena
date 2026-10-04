// Browser side of the watch-only demo. Bundled with the real engine so the browser replays every round itself.
import { cashOut, createRound, placeCoin } from '../src/engine.js';
import type { Mode, Move, RoundState } from '../src/types.js';
import { qualityFromVolume } from '../src/quality.js';
import { type Cell, type HubLayout, arcFor, hitLayout, hubLayout, liveCell, ringPositions, spotsFor, tally } from './geometry.js';
import { textFlagFromHash, textFlagFromStore, withHashParam } from './prefs.js';
import {
  DEFAULT_THEME, PRESETS, migrateTheme, type Theme, type ThemeColorKey, THEME_KEYS, coinBase, coinTone, contrastOn, mixHex, normHex, randomTheme, rgba, sameTheme, sanitizeTheme, themeFromHash, themeToHash,
} from './theme.js';

type Plan = {
  roundId: string; mode: Mode; seat: { index: number; arena: number; subArena: number; table: number }; slot: number; botName: string; archetype: string;
  seed: string; volumeUsd: number; quality: number; moves: Move[]; startDelayMs: number; stepMs: number;
  result: { status: string; score: number; rawScore: number; coinsOnTable: number; fallFee: number };
};
type TablesReply = { slot: number; slotStartMs: number; slotMs: number; volumeUsd: number; quality: number; volumeSource: string; serverNow: number; tables: Plan[] };
type Overview = { slot: number; slotStartMs: number; slotMs: number; volumeUsd: number; quality: number; serverNow: number; seats: number[][] };
type Entry = { botName: string; mode: Mode; seat: number; score: number; rawScore: number; roundId: string; slot: number };
type Summary = Record<string, any> & { board: Entry[] };

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const MODES: Mode[] = ['single', 'twin', 'triple'];
const SPEEDS = [0.5, 1, 2, 4];
const COIN_R = 31.75;
const COIN_T = 3;
const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const S = {
  mode: 'single' as Mode, arena: 0, sub: 0, vol: 'live', table: 0,
  view: 'rings' as 'rings' | 'grid', level: 0, hover: -1,
  anim: null as null | { t0: number; dir: number }, dirty: true,
  text: true, hubT: -1, hubStamp: 0, speed: 1, paused: false, vt: 0, lastReal: 0, clockOffset: 0, serverSlot: 0, slotMs: 60000,
  config: null as any, summary: null as Summary | null,
};

// ---- theme -----------------------------------------------------------------------------------
let T: Theme = { ...DEFAULT_THEME };
const THEME_STORE = 'caphet-theme-v2';
const TEXT_STORE = 'caphet-text';
function applyTheme(): void {
  const st = document.documentElement.style;
  st.setProperty('--bg', T.bg); st.setProperty('--text', T.text); st.setProperty('--coin', T.coin); st.setProperty('--ring', T.ring);
  st.setProperty('--accent', T.hub); st.setProperty('--ok', T.cashed); st.setProperty('--bad', T.fell); st.setProperty('--botc', T.bot); st.setProperty('--platform', T.platform);
}
function setTheme(patch: Partial<Theme>, save = true): void {
  T = sanitizeTheme({ ...T, ...patch });
  applyTheme();
  if (save) { try { localStorage.setItem(THEME_STORE, JSON.stringify(T)); } catch { /* private mode */ } }
  cards.forEach((c) => { c.lastK = -1; });
  lastFocusKey = ''; rightKey = ''; S.dirty = true;
  syncColorInputs();
}
function loadTheme(): void {
  let found: Theme | null = null;
  try { const raw = localStorage.getItem(THEME_STORE); if (raw) found = migrateTheme(sanitizeTheme(JSON.parse(raw))); } catch { /* ignore */ }
  const fromHash = themeFromHash(location.hash);
  if (fromHash) found = fromHash;
  if (found) { T = found; if (fromHash) { try { localStorage.setItem(THEME_STORE, JSON.stringify(T)); } catch { /* ignore */ } } }
  applyTheme();
}

// ---- clock: virtual time follows the server clock, can be paused and sped up -----------------
const realNow = (): number => Date.now() + S.clockOffset;
function tickClock(): void {
  const r = realNow();
  if (S.vt === 0) S.vt = r;
  const dt = r - S.lastReal;
  S.lastReal = r;
  if (!S.paused) S.vt += dt * S.speed;
  if (S.vt > r + 20 * 60000) S.vt = r; // do not run too far ahead of what the server will hand out
}

// ---- data ----------------------------------------------------------------------------------
const planCache = new Map<string, Promise<TablesReply>>();
const repStore = new Map<string, TablesReply>();
const keyOf = (slot: number): string => `${S.mode}|${S.arena}|${S.sub}|${S.vol}|${slot}`;
function loadSlot(slot: number): Promise<TablesReply> {
  const k = keyOf(slot);
  let p = planCache.get(k);
  if (!p) {
    p = fetch(`/demo/tables?mode=${S.mode}&arena=${S.arena}&sub=${S.sub}&vol=${S.vol}&slot=${slot}`).then(async (r) => {
      if (!r.ok) throw new Error(String(r.status));
      const j = (await r.json()) as TablesReply;
      S.clockOffset = j.serverNow - Date.now();
      S.serverSlot = Math.floor(j.serverNow / j.slotMs);
      S.slotMs = j.slotMs;
      repStore.set(k, j); S.dirty = true;
      if (repStore.size > 40) repStore.delete(repStore.keys().next().value!);
      return j;
    });
    p.catch(() => planCache.delete(k));
    planCache.set(k, p);
    if (planCache.size > 40) planCache.delete(planCache.keys().next().value!);
  }
  return p;
}
const ovPromises = new Map<string, Promise<Overview>>();
const ovStore = new Map<string, Overview>();
const ovKey = (slot: number): string => `${S.mode}|${S.vol}|${slot}`;
function loadOverview(slot: number): void {
  const k = ovKey(slot);
  if (ovPromises.has(k)) return;
  const p = fetch(`/demo/overview?mode=${S.mode}&vol=${S.vol}&slot=${slot}`).then(async (r) => {
    if (!r.ok) throw new Error(String(r.status));
    const j = (await r.json()) as Overview;
    S.clockOffset = j.serverNow - Date.now();
    S.slotMs = j.slotMs;
    ovStore.set(k, j); S.dirty = true;
    if (ovStore.size > 12) ovStore.delete(ovStore.keys().next().value!);
    return j;
  });
  p.catch(() => ovPromises.delete(k));
  ovPromises.set(k, p);
  if (ovPromises.size > 12) ovPromises.delete(ovPromises.keys().next().value!);
}
let lastOv: Overview | null = null;

// ---- engine replay in the browser ------------------------------------------------------------
const stateCache = new Map<string, RoundState[]>();
function stateAt(plan: Plan, k: number): RoundState {
  let arr = stateCache.get(plan.roundId);
  if (!arr) {
    arr = [createRound(plan.mode, plan.seed, plan.volumeUsd)];
    stateCache.set(plan.roundId, arr);
    if (stateCache.size > 60) stateCache.delete(stateCache.keys().next().value!);
  }
  while (arr.length <= k) {
    const m = plan.moves[arr.length - 1]!;
    const prev = arr[arr.length - 1]!;
    arr.push(m.type === 'place' ? placeCoin(prev, { dx: m.dx, dy: m.dy }, m.stack) : cashOut(prev));
  }
  return arr[k]!;
}
/** Does the browser's own replay give the result the server stated? */
function verified(plan: Plan): boolean {
  const s = stateAt(plan, plan.moves.length);
  const r = plan.result;
  return s.status === r.status && s.score === r.score && s.rawScore === r.rawScore && s.coinsOnTable === r.coinsOnTable;
}
/** Which move a table has reached at virtual time vt. */
function progress(rep: TablesReply, plan: Plan): { k: number; waiting: boolean; since: number } {
  const t = S.vt - rep.slotStartMs - plan.startDelayMs;
  const waiting = t < 0;
  const k = waiting ? 0 : Math.min(plan.moves.length, Math.floor(t / plan.stepMs) + 1);
  const since = waiting ? 0 : (t - (k - 1) * plan.stepMs) / 350; // newest coin pops in
  return { k, waiting, since };
}

// ---- drawing: canvas helpers -----------------------------------------------------------------
function fit(cv: HTMLCanvasElement, h?: number): CanvasRenderingContext2D {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(60, Math.floor(cv.clientWidth * dpr));
  const hh = h ? Math.max(60, Math.floor(h * dpr)) : w;
  if (cv.width !== w || cv.height !== hh) { cv.width = w; cv.height = hh; }
  return cv.getContext('2d')!;
}
function disc(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void { ctx.beginPath(); ctx.arc(x, y, Math.max(0, r), 0, Math.PI * 2); }

/** A filled circle with a solid outline band on the inside of its edge, so the band touches the fill with no gap. */
function banded(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string, band: string, w: number): void {
  disc(ctx, x, y, r); ctx.fillStyle = band; ctx.fill();
  disc(ctx, x, y, r - Math.min(w, r * 0.45)); ctx.fillStyle = fill; ctx.fill();
}

/**
 * One table seen from above, centred at (cx, cy) with the table edge at radius R (canvas pixels).
 * With surface = false the caller has already painted the table surface (the table circle in the ring views),
 * so only the guide rings, stack homes and coins are drawn.
 */
function drawOverheadAt(ctx: CanvasRenderingContext2D, st: RoundState, cx: number, cy: number, R: number, fresh: number, quality: number, surface = true): void {
  const k = R / 200; // line widths and shadows scale with the drawing
  let viewR = st.tableRadiusMm;
  if (st.mode === 'single') { // single stacks only reach about 100 mm, so zoom in on the middle of the big table
    let far = 0;
    for (const c of st.stacks[0]!) far = Math.max(far, Math.hypot(c.x - st.homes[0]!.x, c.y - st.homes[0]!.y));
    viewR = Math.min(st.tableRadiusMm, Math.max(120, far + COIN_R + 30));
  }
  const scale = R / viewR;
  const P = (x: number, y: number): [number, number] => [cx + (x - st.tableCenter.x) * scale, cy + (y - st.tableCenter.y) * scale];
  // the table surface, with its outline as a solid band inside the edge
  const tr = st.tableRadiusMm * scale;
  const fillR = Math.min(tr, R);
  if (surface) {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(10, fillR));
    g.addColorStop(0, T.table); g.addColorStop(1, mixHex(T.table, contrastOn(T.table), 0.07));
    disc(ctx, cx, cy, fillR); ctx.fillStyle = T.ring; ctx.fill();
    disc(ctx, cx, cy, Math.max(1, fillR - Math.max(1.5, 2 * k))); ctx.fillStyle = g; ctx.fill();
  } else if (tr < R * 0.999) {
    disc(ctx, cx, cy, tr); ctx.strokeStyle = rgba(T.ring, 0.4); ctx.lineWidth = Math.max(0.8, k); ctx.stroke(); // the real edge of a small table
  }
  ctx.strokeStyle = rgba(T.ring, 0.14); ctx.lineWidth = Math.max(0.5, k);
  for (let rr = 50; rr < st.tableRadiusMm && rr * scale < R; rr += 50) { disc(ctx, cx, cy, rr * scale); ctx.stroke(); }
  // where each stack starts
  ctx.setLineDash([4 * k, 4 * k]); ctx.strokeStyle = rgba(T.ring, 0.5); ctx.lineWidth = Math.max(0.8, k);
  for (const h of st.homes) { const [x, y] = P(h.x, h.y); disc(ctx, x, y, COIN_R * scale); ctx.stroke(); }
  ctx.setLineDash([]);
  // stacks that touch
  st.pairs.forEach((pr, i) => {
    if (!st.touching[i]) return;
    const a = st.homes[pr[0]]!, b = st.homes[pr[1]]!;
    const [x1, y1] = P(a.x, a.y), [x2, y2] = P(b.x, b.y);
    ctx.strokeStyle = T.hub; ctx.lineWidth = Math.max(1.5, 3 * k); ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  });
  // coins, bottom to top
  const base = coinBase(T, quality);
  st.stacks.forEach((stack, si) => {
    stack.forEach((c, i) => {
      const [x, y] = P(c.x, c.y);
      const r = COIN_R * scale;
      const lift = Math.min(10, i * 0.5) * k * 2;
      const topIdx = i === stack.length - 1;
      const pop = topIdx ? Math.min(1, fresh) : 1;
      const tone = coinTone(base, st.mode === 'single' ? 0 : si, i);
      ctx.save();
      ctx.translate(0, -lift);
      ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 5 * k * 2; ctx.shadowOffsetY = 2 * k * 2;
      const rr = r * (0.6 + 0.4 * pop);
      const grad = ctx.createRadialGradient(x - rr * 0.35, y - rr * 0.35, rr * 0.1, x, y, rr);
      grad.addColorStop(0, tone.light); grad.addColorStop(1, tone.dark);
      disc(ctx, x, y, rr); ctx.fillStyle = grad; ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.strokeStyle = tone.edge; ctx.lineWidth = Math.max(1, rr * 0.07); ctx.stroke();
      disc(ctx, x, y, rr * 0.68); ctx.strokeStyle = rgba(tone.ring, 0.55); ctx.lineWidth = Math.max(1, rr * 0.05); ctx.stroke();
      if (topIdx && st.status === 'fell' && st.fall?.stack === si) { disc(ctx, x, y, rr + 2 * k); ctx.strokeStyle = T.fell; ctx.lineWidth = Math.max(2, 3 * k); ctx.stroke(); }
      else if (topIdx && st.status === 'active') { disc(ctx, x, y, rr + 2 * k); ctx.strokeStyle = rgba(contrastOn(T.table), 0.6); ctx.lineWidth = Math.max(1, 1.5 * k); ctx.stroke(); }
      ctx.restore();
    });
  });
}
function drawOverhead(cv: HTMLCanvasElement, st: RoundState, fresh: number, quality: number): void {
  const ctx = fit(cv);
  const w = cv.width;
  ctx.clearRect(0, 0, w, w);
  drawOverheadAt(ctx, st, w / 2, w / 2, w / 2 - 3, fresh, quality);
}

/** The stack standing on its platform, seen from a little above (like a small 3D picture). Coin thickness is drawn bigger than real. */
function drawStanding(cv: HTMLCanvasElement, st: RoundState, quality: number): void {
  const ctx = fit(cv, cv.clientHeight || cv.clientWidth * 1.1);
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, maxN = 1;
  st.stacks.forEach((s) => { maxN = Math.max(maxN, s.length); s.forEach((c) => { minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x); minY = Math.min(minY, c.y); maxY = Math.max(maxY, c.y); }); });
  for (const h of st.homes) { minX = Math.min(minX, h.x); maxX = Math.max(maxX, h.x); minY = Math.min(minY, h.y); maxY = Math.max(maxY, h.y); }
  const THICK = 2.6, TILT = 0.3;
  const th = COIN_T * THICK;
  const Rp = Math.min(st.tableRadiusMm, Math.max(100, (maxX - minX) / 2 + COIN_R * 1.7, (maxY - minY) / 2 + COIN_R * 1.7));
  const cxw = (minX + maxX) / 2, cyw = (minY + maxY) / 2;
  const s = Math.min((W * 0.94) / (2 * Rp), (H * 0.9) / (maxN * th + 2 * Rp * TILT + 16));
  const slab = Math.max(4, Rp * s * 0.045);
  const px = W / 2, py = H - H * 0.04 - slab - Rp * TILT * s;
  // soft light behind the stack
  const glow = ctx.createRadialGradient(px, H * 0.42, 0, px, H * 0.42, W * 0.75);
  glow.addColorStop(0, rgba(T.text, 0.09)); glow.addColorStop(1, rgba(T.text, 0));
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);
  // platform: slab, top, rings
  const ex = Rp * s, ey = Rp * TILT * s;
  const edge = mixHex(T.subarena, '#000000', 0.25);
  ctx.beginPath(); ctx.ellipse(px, py + slab, ex, ey, 0, 0, Math.PI * 2); ctx.fillStyle = edge; ctx.fill();
  ctx.beginPath(); ctx.moveTo(px - ex, py); ctx.lineTo(px - ex, py + slab); ctx.ellipse(px, py + slab, ex, ey, 0, Math.PI, 0, true); ctx.lineTo(px + ex, py); ctx.closePath(); ctx.fillStyle = T.subarena; ctx.fill();
  ctx.strokeStyle = T.ring; ctx.lineWidth = Math.max(1, W / 360); ctx.stroke();
  ctx.beginPath(); ctx.ellipse(px, py, ex, ey, 0, 0, Math.PI * 2);
  const tg = ctx.createRadialGradient(px, py - ey * 0.3, 0, px, py, ex);
  tg.addColorStop(0, T.table); tg.addColorStop(1, mixHex(T.table, contrastOn(T.table), 0.1));
  ctx.fillStyle = tg; ctx.fill(); ctx.strokeStyle = T.ring; ctx.lineWidth = Math.max(1.2, W / 300); ctx.stroke();
  ctx.strokeStyle = rgba(T.ring, 0.15); ctx.lineWidth = 1;
  for (const f of [0.34, 0.67]) { ctx.beginPath(); ctx.ellipse(px, py, ex * f, ey * f, 0, 0, Math.PI * 2); ctx.stroke(); }
  // stacks, back to front
  const base = coinBase(T, quality);
  const order = st.stacks.map((stack, si) => ({ stack, si, y: stack.length ? stack.reduce((a, c) => a + c.y, 0) / stack.length : 0 })).sort((a, b) => a.y - b.y);
  for (const o of order) {
    if (!o.stack.length) continue;
    const c0 = o.stack[0]!;
    const bx = px + (c0.x - cxw) * s, by = py + (c0.y - cyw) * s * TILT;
    ctx.beginPath(); ctx.ellipse(bx, by + 1, COIN_R * s * 1.12, COIN_R * s * TILT * 1.18, 0, 0, Math.PI * 2); ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.fill();
    o.stack.forEach((c, i) => {
      const sx = px + (c.x - cxw) * s;
      const y0 = py + (c.y - cyw) * s * TILT - i * th * s;
      const rx = COIN_R * s, ry = COIN_R * s * TILT, hgt = th * s * 0.94;
      const tone = coinTone(base, st.mode === 'single' ? 0 : o.si, i);
      const g = ctx.createLinearGradient(sx - rx, 0, sx + rx, 0);
      g.addColorStop(0, tone.edge); g.addColorStop(0.28, tone.light); g.addColorStop(0.65, tone.dark); g.addColorStop(1, tone.edge);
      ctx.beginPath(); ctx.moveTo(sx - rx, y0 - hgt); ctx.lineTo(sx - rx, y0); ctx.ellipse(sx, y0, rx, ry, 0, Math.PI, 0, true); ctx.lineTo(sx + rx, y0 - hgt); ctx.ellipse(sx, y0 - hgt, rx, ry, 0, 0, Math.PI, false); ctx.closePath();
      ctx.fillStyle = g; ctx.fill(); ctx.strokeStyle = tone.edge; ctx.lineWidth = Math.max(0.6, W / 700); ctx.stroke();
      ctx.beginPath(); ctx.ellipse(sx, y0 - hgt, rx, ry, 0, 0, Math.PI * 2);
      const tg2 = ctx.createRadialGradient(sx - rx * 0.3, y0 - hgt - ry * 0.3, 0, sx, y0 - hgt, rx);
      tg2.addColorStop(0, tone.ring); tg2.addColorStop(1, tone.light);
      ctx.fillStyle = tg2; ctx.fill(); ctx.strokeStyle = tone.edge; ctx.stroke();
      if (i === o.stack.length - 1) {
        ctx.beginPath(); ctx.ellipse(sx, y0 - hgt, rx * 0.34, ry * 0.34, 0, 0, Math.PI * 2); ctx.fillStyle = rgba(tone.edge, 0.55); ctx.fill();
        if (st.status === 'fell' && st.fall?.stack === o.si) { ctx.beginPath(); ctx.ellipse(sx, y0 - hgt, rx + 3, ry + 3, 0, 0, Math.PI * 2); ctx.strokeStyle = T.fell; ctx.lineWidth = Math.max(2, W / 200); ctx.stroke(); }
      }
    });
  }
  if (!S.text) return;
  ctx.fillStyle = rgba(T.text, 0.6); ctx.font = `${Math.max(10, W / 34)}px ui-monospace,monospace`;
  ctx.fillText(`standing view, coin thickness drawn ${THICK}x`, 10, Math.max(14, W / 30));
}

// ---- UI helpers -----------------------------------------------------------------------------
function status(plan: Plan, st: RoundState, waiting: boolean): { cls: string; text: string } {
  if (waiting) return { cls: '', text: 'WAITING' };
  if (st.status === 'fell') return { cls: 'fell', text: 'FELL' };
  if (st.status === 'touched') return { cls: 'touched', text: 'CONNECTED' };
  if (st.status === 'cashed' || st.status === 'maxed') return { cls: 'cashed', text: 'CASHED OUT' };
  return { cls: 'play', text: 'PLAYING' };
}
const unit = (mode: Mode): string => (mode === 'single' ? 'mm' : 'coins');
function scoreText(plan: Plan, st: RoundState, waiting: boolean): string {
  if (waiting) return '-';
  if (st.status === 'fell') return '0';
  if (plan.mode !== 'single' && st.status === 'cashed') return 'no score';
  return `${st.score} ${unit(plan.mode)}`;
}

// ---- the grid view (the original ten-card layout) ---------------------------------------------
let cards: { el: HTMLElement; cv: HTMLCanvasElement; top: HTMLElement; badge: HTMLElement; score: HTMLElement; coins: HTMLElement; lastK: number; lastId: string; popAt: number }[] = [];
function buildGrid(): void {
  const grid = $('grid');
  grid.innerHTML = '';
  cards = [];
  for (let t = 0; t < 10; t++) {
    const el = document.createElement('div');
    el.className = 'card';
    el.innerHTML = `<div class="top"><b>T${t}</b><span class="nm"></span></div><canvas></canvas><div class="bot"><span class="badge">-</span><span class="score">-</span></div><div class="top"><span class="cn"></span><span class="q"></span></div>`;
    el.addEventListener('click', () => { S.table = t; syncSel(); lastFocusKey = ''; });
    grid.appendChild(el);
    cards.push({ el, cv: el.querySelector('canvas')!, top: el.querySelector('.nm')!, badge: el.querySelector('.badge')!, score: el.querySelector('.score')!, coins: el.querySelector('.cn')!, lastK: -1, lastId: '', popAt: 0 });
  }
  syncSel();
}
function syncSel(): void { cards.forEach((c, i) => c.el.classList.toggle('sel', i === S.table)); }
function updateGrid(rep: TablesReply): void {
  rep.tables.forEach((plan, i) => {
    const c = cards[i]; if (!c) return;
    const { k, waiting, since } = progress(rep, plan);
    const st = stateAt(plan, k);
    const animating = since < 1 && k < plan.moves.length + 1 && !waiting;
    if (c.lastK !== k || c.lastId !== plan.roundId || animating) {
      if (c.lastId !== plan.roundId) c.top.textContent = plan.botName;
      c.lastK = k; c.lastId = plan.roundId;
      drawOverhead(c.cv, st, animating ? since : 1, plan.quality);
      const s = status(plan, st, waiting);
      c.badge.className = 'badge ' + s.cls; c.badge.textContent = s.text;
      c.score.textContent = scoreText(plan, st, waiting);
      c.coins.textContent = `${st.coinsOnTable} coins`;
      (c.el.querySelector('.q') as HTMLElement).textContent = `Q ${Math.round(plan.quality * 100)}%`;
    }
  });
}

// ---- navigation: hub > arena > sub-arena > table ----------------------------------------------
const LEVEL_NAMES = ['HUB', 'ARENA', 'SUB-ARENA', 'TABLE'];
function go(level: number, arena?: number, sub?: number, table?: number): void {
  const dir = level >= S.level ? 1 : -1;
  S.level = Math.max(0, Math.min(3, level));
  if (arena !== undefined) S.arena = arena;
  if (sub !== undefined) S.sub = sub;
  if (table !== undefined) S.table = table;
  S.hover = -1; S.dirty = true;
  S.anim = { t0: performance.now(), dir };
  lastFocusKey = ''; rightKey = ''; closeKey = '';
  buildCrumb(); applyViewClasses(); syncSel();
}
function up(): void { if (S.view === 'rings' && S.level > 0) go(S.level - 1); }
function applyViewClasses(): void {
  document.body.classList.toggle('grid', S.view === 'grid');
  document.body.classList.toggle('close', S.view === 'rings' && S.level === 3);
  $('gridPick').style.display = S.view === 'grid' ? 'flex' : 'none';
  ($('textBtn') as HTMLButtonElement).disabled = S.view === 'grid';
  ($('back') as HTMLButtonElement).disabled = !(S.view === 'rings' && S.level > 0);
  const hints = [
    'Each arena holds 10 sub-arenas. Every small circle has 10 arcs, one per table: thin and faint = waiting for its bot, red = placing coins (the arc gets thicker as the stack grows), orange = cashed out, bright red = fell. The disc in the middle grows as coins land. Tap an arena to open it.',
    `Arena ${S.arena}: each circle is a sub-arena and each dot inside is one of its 10 tables. Discs grow as coins land (twin shows 2 stack spots per table, triple shows 3). Tap a sub-arena.`,
    `Arena ${S.arena}, sub-arena ${S.sub}: tap a table to see its stack up close.`,
    '',
  ];
  $('hint').textContent = S.view === 'rings' ? hints[S.level]! : '';
  $('note').textContent = S.view === 'rings' ? 'Play coins only \u00b7 house bots \u00b7 tap a circle to go in, BACK to come out' : 'Play coins only \u00b7 house bots \u00b7 tap a table card to zoom';
}
function buildCrumb(): void {
  const el = $('crumb');
  if (S.view === 'grid') { el.innerHTML = `<b>${S.mode}</b> &gt; arena <b>${S.arena}</b> &gt; sub-arena <b>${S.sub}</b> &gt; tables <b>${S.arena * 100 + S.sub * 10}-${S.arena * 100 + S.sub * 10 + 9}</b>`; return; }
  const labels = ['HUB', `ARENA ${S.arena}`, `SUB-ARENA ${S.sub}`, `TABLE ${S.table}`];
  el.innerHTML = '';
  for (let l = 0; l <= S.level; l++) {
    if (l) el.appendChild(document.createTextNode('>'));
    const b = document.createElement('button');
    b.textContent = labels[l]!; b.className = l === S.level ? 'on' : '';
    b.onclick = () => { if (l !== S.level) go(l); };
    el.appendChild(b);
  }
}
function buildControls(): void {
  S.dirty = true;
  const modes = $('modes');
  modes.innerHTML = '';
  MODES.forEach((m) => { const b = document.createElement('button'); b.textContent = m; b.className = m === S.mode ? 'on' : ''; b.onclick = () => { S.mode = m; S.summary = null; afterSelect(); }; modes.appendChild(b); });
  const views = $('views'); views.innerHTML = '';
  for (const [v, label] of [['rings', 'ARENA OF ARENAS'], ['grid', 'TABLE GRID']] as const) {
    const b = document.createElement('button'); b.textContent = label; b.className = S.view === v ? 'on' : '';
    b.onclick = () => { S.view = v; S.anim = { t0: performance.now(), dir: 1 }; lastFocusKey = ''; rightKey = ''; buildControls(); buildCrumb(); applyViewClasses(); };
    views.appendChild(b);
  }
  for (const [id, key] of [['arenas', 'arena'], ['subs', 'sub']] as const) {
    const wrap = $(id); wrap.innerHTML = '';
    for (let i = 0; i < 10; i++) { const b = document.createElement('button'); b.textContent = String(i); b.className = S[key] === i ? 'on' : ''; b.onclick = () => { S[key] = i; afterSelect(); }; wrap.appendChild(b); }
  }
  const vol = $<HTMLSelectElement>('vol');
  if (!vol.options.length) {
    const choices: string[] = (S.config?.volumeChoices ?? ['live', 500, 5000, 30000, 100000]).map(String);
    choices.forEach((c) => { const o = document.createElement('option'); o.value = c; o.textContent = c === 'live' ? 'Live CAPH volume' : `What-if $${fmt(Number(c))}`; vol.appendChild(o); });
    vol.onchange = () => { S.vol = vol.value; S.summary = null; afterSelect(); };
  }
  vol.value = S.vol;
  const sp = $('speeds'); sp.innerHTML = '';
  SPEEDS.forEach((v) => { const b = document.createElement('button'); b.textContent = v + 'x'; b.className = v === S.speed ? 'on' : ''; b.onclick = () => { S.speed = v; buildControls(); }; sp.appendChild(b); });
  $('pause').className = S.paused ? 'on' : '';
  $('pause').innerHTML = S.paused ? '&#9654;' : '&#10073;&#10073;';
}
function afterSelect(): void { lastOv = null; S.table = Math.min(S.table, 9); buildControls(); buildCrumb(); syncSel(); lastFocusKey = ''; rightKey = ''; closeKey = ''; refreshSummary(); }

// ---- the ring stage (hub, arenas, sub-arenas, tables) -------------------------------------------
const jitter = (seat: number, salt: number): number => ((Math.imul(seat + salt * 977, 2654435761) >>> 0) % 1000) / 500 - 1; // -1..1, steady per seat

function hubDraw(ctx: CanvasRenderingContext2D, cx: number, cy: number, hubR: number, line: string): void {
  banded(ctx, cx, cy, hubR, T.hubFill, T.hub, Math.max(1.5, hubR * 0.04));
  if (!S.text) return;
  ctx.fillStyle = T.hub; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `bold ${Math.max(7, hubR * 0.2)}px ui-monospace,monospace`;
  const lh = hubR * 0.24;
  ctx.fillText('COLLECTION', cx, cy - lh * 1.2); ctx.fillText('CENTER', cx, cy - lh * 0.2); ctx.fillText('HUB', cx, cy + lh * 0.8);
  if (line) { ctx.font = `${Math.max(6, hubR * 0.13)}px ui-monospace,monospace`; ctx.globalAlpha *= 0.85; ctx.fillText(line, cx, cy + lh * 1.75); ctx.globalAlpha /= 0.85; }
}
/** The current hub layout (set at the start of every stage draw). Slot circles stay the size they always were; the petal behind each one grows as the hub shrinks. */
let LAY: HubLayout | null = null;
/** A slot's backdrop: a circle (the petal) cut by the straight lines halfway to its neighbours, with a solid band inside its edge. At the biggest hub it is exactly the plain circle. */
function node(ctx: CanvasRenderingContext2D, i: number, lw: number, stroke: string, hot: boolean, fill: string): void {
  const L = LAY!;
  const ang = L.ring.positions[i]!.angle;
  const px = L.cx + Math.cos(ang) * L.petalDist, py = L.cy + Math.sin(ang) * L.petalDist;
  const bw = Math.min(hot ? lw * 1.8 : lw, L.petalR * 0.45);
  const band = hot ? T.hub : stroke;
  const half = Math.PI / L.ring.positions.length;
  const wedge = (shift: number): void => {
    // apex moved out along the middle line by shift / sin(half) so every side line moves in by `shift`
    const ax = L.cx + Math.cos(ang) * (shift / Math.sin(half)), ay = L.cy + Math.sin(ang) * (shift / Math.sin(half));
    const len = L.outerR * 1.5 / Math.cos(half);
    ctx.beginPath(); ctx.moveTo(ax, ay);
    ctx.lineTo(ax + Math.cos(ang - half) * len, ay + Math.sin(ang - half) * len);
    ctx.lineTo(ax + Math.cos(ang + half) * len, ay + Math.sin(ang + half) * len);
    ctx.closePath(); ctx.clip();
  };
  // the petal is its circle plus the pie slice next to the hub (so the hub is wrapped with no gap when it is small)
  const shape = (inset: number): void => {
    ctx.beginPath();
    ctx.arc(px, py, Math.max(0, L.petalR - inset), 0, Math.PI * 2);
    ctx.moveTo(L.cx + L.sectorR, L.cy); ctx.arc(L.cx, L.cy, L.sectorR, 0, Math.PI * 2);
  };
  ctx.save(); wedge(0); shape(0); ctx.fillStyle = band; ctx.fill(); ctx.restore();
  // neighbours each take half the band along the shared straight sides, so those sides end up one band wide in total
  ctx.save(); wedge(bw / 2); shape(bw); ctx.fillStyle = fill; ctx.fill(); ctx.restore();
}
/** One table as a small circle with its live stack spots (1 for single, 2 for twin, 3 for triple). */
function tableDot(ctx: CanvasRenderingContext2D, q: { x: number; y: number; r: number }, c: Cell, seat: number, base: string): void {
  const bw = Math.max(0.7, q.r * 0.1);
  banded(ctx, q.x, q.y, q.r, T.table, T.ring, bw);
  if (c.flash > 0 && c.phase !== 'play') { disc(ctx, q.x, q.y, q.r - bw); ctx.fillStyle = rgba(c.phase === 'fell' ? T.fell : T.cashed, 0.55 * c.flash); ctx.fill(); }
  if (c.phase === 'wait') return;
  if (c.phase === 'fell') { disc(ctx, q.x, q.y, q.r * 0.6); ctx.strokeStyle = T.fell; ctx.lineWidth = Math.max(1, q.r * (0.2 + 0.2 * c.flash)); ctx.stroke(); return; }
  const spots = spotsFor(S.mode === 'single' ? 1 : S.mode === 'twin' ? 2 : 3);
  const pulse = c.phase === 'play' ? Math.max(0, 1 - c.sinceMove / 300) : 0;
  spots.forEach((sp, i) => {
    const off = (1 - c.size) * q.r * 0.25 * (spots.length === 1 ? 1 : 0);
    const x = q.x + sp.x * q.r + jitter(seat, 1 + i) * off, y = q.y + sp.y * q.r + jitter(seat + 7, 2 + i) * off;
    const r = q.r * (spots.length === 1 ? 0.22 + 0.7 * c.size : sp.r * (0.35 + 0.6 * c.size)) * (1 + 0.1 * pulse);
    disc(ctx, x, y, r); ctx.fillStyle = base; ctx.fill();
    if (pulse > 0) { disc(ctx, x, y, r + q.r * 0.12); ctx.strokeStyle = rgba(T.hub, pulse); ctx.lineWidth = Math.max(0.8, q.r * 0.1); ctx.stroke(); }
    else if (c.phase === 'cashed' || c.phase === 'touched') { ctx.strokeStyle = T.cashed; ctx.lineWidth = Math.max(0.8, q.r * 0.16); ctx.stroke(); }
  });
}
function currentOverview(): Overview | null {
  const slot = Math.floor(S.vt / S.slotMs);
  loadOverview(slot);
  const cur = ovStore.get(ovKey(slot));
  const nextToo = (S.vt % S.slotMs) > S.slotMs - 12000;
  if (nextToo) loadOverview(slot + 1);
  if (cur) { lastOv = cur; return cur; }
  return lastOv;
}
const cellOf = (ov: Overview | null, seat: number): Cell => liveCell(ov?.seats[seat], ov ? S.vt - ov.slotStartMs : -1);

/** The coin volume that sets the hub size: the what-if choice, else the live CAPH volume. */
function hubVolume(ov: Overview | null): number {
  if (S.vol !== 'live') return Number(S.vol) || 0;
  const live = S.summary?.liveVolumeUsd ?? S.summary?.volumeUsd ?? ov?.volumeUsd;
  return Number.isFinite(live) ? Number(live) : 0;
}
/** Move the shown hub size toward the size for this volume (same log scale as coin quality), easing over about half a second. */
function stepHub(target: number): number {
  const now = performance.now();
  const dt = S.hubStamp ? Math.min(250, now - S.hubStamp) : 0;
  S.hubStamp = now;
  if (S.hubT < 0) S.hubT = target;
  else {
    const d = target - S.hubT;
    if (Math.abs(d) < 0.0008) S.hubT = target;
    else { S.hubT += d * (1 - Math.exp(-dt / 220)); S.dirty = true; }
  }
  document.documentElement.dataset.hubT = S.hubT.toFixed(3);
  return S.hubT;
}
function stageGeom(w: number): { cx: number; cy: number; maxR: number } { return { cx: w / 2, cy: w / 2, maxR: w * 0.465 }; }
let hoverText = '';
function drawStage(rep: TablesReply | null): void {
  const cv = $<HTMLCanvasElement>('ring');
  const ctx = fit(cv);
  const w = cv.width;
  ctx.clearRect(0, 0, w, w);
  const { cx, cy, maxR } = stageGeom(w);
  const ov = S.level <= 1 ? currentOverview() : null;
  const quality = ov?.quality ?? rep?.quality ?? 0;
  const base = coinBase(T, quality);
  ctx.save();
  if (S.anim) {
    const p = Math.min(1, (performance.now() - S.anim.t0) / 260);
    const e = 1 - Math.pow(1 - p, 3);
    const sc = S.anim.dir > 0 ? 0.8 + 0.2 * e : 1.14 - 0.14 * e;
    ctx.globalAlpha = 0.2 + 0.8 * e;
    ctx.translate(cx, cy); ctx.scale(sc, sc); ctx.translate(-cx, -cy);
    if (p >= 1) S.anim = null;
  }
  // the big stadium circle
  const lw = Math.max(1.5, w * 0.005);
  banded(ctx, cx, cy, maxR * 1.012, S.level === 0 ? T.platform : S.level === 1 ? T.arena : T.subarena, T.ring, lw * 1.6);
  const lay = hubLayout(cx, cy, maxR, stepHub(qualityFromVolume(hubVolume(ov))));
  LAY = lay;
  const ring = lay.ring;
  let hubLine = '';
  if (S.text && ov && S.level <= 1) { let playing = 0; for (let i = 0; i < 1000; i++) if (cellOf(ov, i).phase === 'play') playing++; hubLine = `${playing} playing \u00b7 next in ${Math.max(0, Math.ceil((S.slotMs - (S.vt % S.slotMs)) / 1000))}s`; }
  const labelCol = contrastOn(S.level === 0 ? T.arena : T.subarena);
  const sec = S.vt - (ov?.slotStartMs ?? 0);
  void sec;
  if (S.level === 0) {
    const lwSeg = Math.max(1, ringPositions(0, 0, ring.circleRadius - lw, 10).circleRadius * 0.2);
    // one batch of arcs per (kind, thickness bucket), so a whole view needs only a few strokes
    const segs: Record<string, Path2D> = {};
    const seg = (kind: string, b: number): Path2D => (segs[kind + b] ??= new Path2D());
    const flashFell = new Path2D(), flashCash = new Path2D();
    const live: { x: number; y: number; r: number; ty: ReturnType<typeof tally> }[] = [];
    const arenaPlaying: number[] = [];
    ring.positions.forEach((p, a) => {
      node(ctx, a, lw, T.ring, S.hover === a, T.arena);
      const inner = ringPositions(p.x, p.y, p.r - lw, 10);
      let playing = 0;
      inner.positions.forEach((q, sb) => {
        const cells: Cell[] = [];
        for (let t = 0; t < 10; t++) cells.push(cellOf(ov, a * 100 + sb * 10 + t));
        const ty = tally(cells);
        playing += ty.play;
        // sub-arena dot: platform, then a growing disc and a pulse when a coin lands
        const bq = Math.max(0.7, q.r * 0.09);
        banded(ctx, q.x, q.y, q.r, T.subarena, T.ring, bq);
        if (ty.flash > 0.02 && (ty.fell || ty.cashed)) { disc(ctx, q.x, q.y, q.r - bq); ctx.fillStyle = rgba(ty.fell ? T.fell : T.cashed, 0.5 * ty.flash); ctx.fill(); }
        // the tables' track: a ring in the table colour that the 10 table arcs sit on
        ctx.beginPath(); ctx.arc(q.x, q.y, q.r * 0.74, 0, Math.PI * 2); ctx.lineWidth = lwSeg * 1.5; ctx.strokeStyle = T.table; ctx.stroke();
        const rd = q.r * (0.14 + 0.36 * ty.size) * (1 + 0.18 * ty.pulse);
        disc(ctx, q.x, q.y, rd); ctx.fillStyle = mixHex(T.subarena, base, Math.min(1, 0.35 + ty.size)); ctx.fill();
        if (ty.pulse > 0.05) { disc(ctx, q.x, q.y, rd + q.r * 0.1); ctx.strokeStyle = rgba(T.hub, ty.pulse); ctx.lineWidth = Math.max(0.6, q.r * 0.07); ctx.stroke(); }
        // ring of 10 arcs, one per table
        for (let t = 0; t < 10; t++) {
          const c = cells[t]!;
          const [a0, a1] = arcFor(t);
          const rr = q.r * 0.74;
          const bucket = c.phase === 'wait' ? 0 : Math.min(3, Math.floor(c.size * 4));
          const path = seg(c.phase === 'wait' ? 'wait' : c.phase === 'fell' ? 'fell' : c.phase === 'play' ? (c.sinceMove < 250 ? 'pulse' : 'play') : 'cashed', bucket);
          path.moveTo(q.x + rr * Math.cos(a0), q.y + rr * Math.sin(a0)); path.arc(q.x, q.y, rr, a0, a1);
          if (c.flash > 0.25 && c.phase !== 'play' && c.phase !== 'wait') {
            const fp = c.phase === 'fell' ? flashFell : flashCash;
            fp.moveTo(q.x + rr * Math.cos(a0), q.y + rr * Math.sin(a0)); fp.arc(q.x, q.y, rr, a0, a1);
          }
        }
        live.push({ x: q.x, y: q.y, r: q.r, ty });
      });
      arenaPlaying.push(playing);
    });
    ctx.lineCap = 'butt';
    const styleOf: Record<string, string> = { wait: rgba(T.ring, 0.22), play: base, pulse: T.hub, cashed: T.cashed, fell: T.fell };
    for (const key of Object.keys(segs)) {
      const kind = key.replace(/\d$/, ''), bucket = Number(key.slice(-1));
      ctx.lineWidth = kind === 'wait' ? lwSeg * 0.5 : lwSeg * (0.45 + 0.33 * bucket);
      ctx.strokeStyle = styleOf[kind]!; ctx.stroke(segs[key]!);
    }
    ctx.lineWidth = lwSeg * 2.4; ctx.globalAlpha *= 0.55; ctx.strokeStyle = T.fell; ctx.stroke(flashFell); ctx.strokeStyle = T.cashed; ctx.stroke(flashCash); ctx.globalAlpha /= 0.55;
    if (S.text) ring.positions.forEach((p, a) => {
      ctx.fillStyle = labelCol; ctx.globalAlpha *= 0.9; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const dev = p.r / Math.min(2, window.devicePixelRatio || 1);
      ctx.font = `bold ${p.r * (dev >= 36 ? 0.3 : 0.36)}px ui-monospace,monospace`; ctx.fillText(String(a), p.x, p.y - (dev >= 36 ? p.r * 0.07 : 0));
      if (dev >= 36) { ctx.font = `${p.r * 0.12}px ui-monospace,monospace`; ctx.fillText(`${arenaPlaying[a]} live`, p.x, p.y + p.r * 0.2); }
      ctx.globalAlpha /= 0.9;
    });
    void live;
  } else if (S.level === 1) {
    ring.positions.forEach((p, sb) => {
      node(ctx, sb, lw, T.ring, S.hover === sb, T.subarena);
      const inner = ringPositions(p.x, p.y, p.r - lw, 10);
      const cells: Cell[] = [];
      inner.positions.forEach((q, t) => {
        const seat = S.arena * 100 + sb * 10 + t;
        const c = cellOf(ov, seat);
        cells.push(c);
        tableDot(ctx, q, c, seat, base);
      });
      const ty = tally(cells);
      const dev = p.r / Math.min(2, window.devicePixelRatio || 1);
      if (!S.text) return;
      ctx.fillStyle = labelCol; ctx.globalAlpha *= 0.9; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = `bold ${p.r * (dev >= 36 ? 0.3 : 0.36)}px ui-monospace,monospace`; ctx.fillText(String(sb), p.x, p.y - (dev >= 36 ? p.r * 0.07 : 0));
      if (dev >= 36) { ctx.font = `${p.r * 0.12}px ui-monospace,monospace`; ctx.fillText(`${ty.play}/10 live`, p.x, p.y + p.r * 0.2); }
      ctx.globalAlpha /= 0.9;
    });
  } else if (S.level === 2) {
    ring.positions.forEach((p, t) => {
      const plan = rep?.tables[t];
      let stroke = T.ring;
      let st: RoundState | null = null; let pr = { k: 0, waiting: true, since: 1 };
      if (plan && rep) { pr = progress(rep, plan); st = stateAt(plan, pr.k); if (!pr.waiting) { if (st.status === 'fell') stroke = T.fell; else if (st.status !== 'active') stroke = T.cashed; } }
      node(ctx, t, lw * 1.2, stroke, S.hover === t, T.table);
      if (!plan || !st) return;
      const R = p.r * (S.text ? 0.66 : 0.84);
      drawOverheadAt(ctx, st, p.x, p.y - p.r * (S.text ? 0.2 : 0.04), R, pr.since < 1 && !pr.waiting ? pr.since : 1, plan.quality, false);
      const dev = p.r / Math.min(2, window.devicePixelRatio || 1);
      const tableLabel = contrastOn(T.table);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = tableLabel;
      if (!S.text) { disc(ctx, p.x, p.y + p.r * 0.9, Math.max(2, p.r * 0.06)); ctx.fillStyle = T.bot; ctx.fill(); return; }
      if (dev >= 40) {
        const nf = p.r * 0.14;
        ctx.font = `${nf}px ui-monospace,monospace`;
        const nm = plan.botName; const tw = ctx.measureText(nm).width;
        ctx.fillText(nm, p.x + p.r * 0.05, p.y + p.r * 0.6);
        disc(ctx, p.x - tw / 2 - p.r * 0.06, p.y + p.r * 0.6, Math.max(2, p.r * 0.045)); ctx.fillStyle = T.bot; ctx.fill(); ctx.fillStyle = tableLabel;
      } else { disc(ctx, p.x, p.y + p.r * 0.62, Math.max(2, p.r * 0.07)); ctx.fillStyle = T.bot; ctx.fill(); ctx.fillStyle = tableLabel; }
      ctx.font = `bold ${p.r * 0.2}px ui-monospace,monospace`;
      ctx.fillText(scoreText(plan, st, pr.waiting), p.x, p.y + p.r * 0.82);
    });
  }
  hubDraw(ctx, cx, cy, lay.hubR, hubLine);
  ctx.restore();
  if (S.text && rep == null && S.level >= 2) { ctx.fillStyle = T.hub; ctx.textAlign = 'center'; ctx.font = `${w / 30}px ui-monospace,monospace`; ctx.fillText('loading...', cx, cy + w * 0.2); }
  void hoverText;
}
function stageHit(ev: PointerEvent | MouseEvent): number {
  const cv = $<HTMLCanvasElement>('ring');
  const rect = cv.getBoundingClientRect();
  const x = ((ev.clientX - rect.left) / rect.width) * cv.width, y = ((ev.clientY - rect.top) / rect.height) * cv.width;
  const { cx, cy, maxR } = stageGeom(cv.width);
  return hitLayout(hubLayout(cx, cy, maxR, S.hubT < 0 ? 0 : S.hubT), x, y);
}
function hoverInfo(i: number): string {
  if (i === -2) return S.level ? 'Collection Center Hub. Tap to go back one step.' : 'Collection Center Hub: where all the arenas meet.';
  if (i < 0) return '';
  if (S.level === 2) {
    const rep = repStore.get(keyOf(Math.floor(S.vt / S.slotMs)));
    const plan = rep?.tables[i];
    if (!plan || !rep) return '';
    const pr = progress(rep, plan); const st = stateAt(plan, pr.k);
    return `<b>${esc(plan.botName)}</b> \u00b7 ${scoreText(plan, st, pr.waiting)} \u00b7 ${status(plan, st, pr.waiting).text.toLowerCase()} \u00b7 tap for the close-up`;
  }
  const ov = lastOv;
  const first = S.level === 0 ? i * 100 : S.arena * 100 + i * 10;
  const n = S.level === 0 ? 100 : 10;
  const cells: Cell[] = [];
  for (let t = 0; t < n; t++) cells.push(cellOf(ov, first + t));
  const ty = tally(cells);
  const nm = S.level === 0 ? `Arena ${i}` : `Sub-arena ${i} of arena ${S.arena}`;
  return `<b>${nm}</b> \u00b7 ${n} tables \u00b7 ${ty.play} placing coins \u00b7 ${ty.wait} waiting \u00b7 ${ty.cashed} cashed out \u00b7 ${ty.fell} fell \u00b7 tap to open`;
}
function onStagePointer(ev: PointerEvent): void {
  const i = stageHit(ev);
  S.hover = i >= 0 ? i : -1; S.dirty = true;
  $('hover').innerHTML = hoverInfo(i);
}
function onStageClick(ev: MouseEvent): void {
  const i = stageHit(ev);
  if (i === -2) { if (S.level > 0) up(); else showInfo(); return; }
  if (i < 0) return;
  if (S.level === 0) go(1, i);
  else if (S.level === 1) go(2, undefined, i);
  else if (S.level === 2) go(3, undefined, undefined, i);
}

// ---- close-up (level 3) ------------------------------------------------------------------------
let closeKey = '';
function updateClose(rep: TablesReply | null): void {
  const plan = rep?.tables[S.table];
  if (!rep || !plan) return;
  const { k, waiting, since } = progress(rep, plan);
  const st = stateAt(plan, k);
  const sstat = status(plan, st, waiting);
  const key = `${plan.roundId}|${sstat.text}|${scoreText(plan, st, waiting)}|${S.table}`;
  if (key !== closeKey) {
    closeKey = key;
    $('closeHead').innerHTML = `<button id="prevT" title="previous table">&#8592;</button><button id="nextT" title="next table">&#8594;</button><span class="dot"></span><span class="nm">${esc(plan.botName)}</span><span class="badge ${sstat.cls}">${sstat.text}</span><span class="score">${scoreText(plan, st, waiting)}</span><span class="sp"></span><span style="color:var(--dim)">table ${S.table} of sub-arena ${S.sub}, arena ${S.arena}</span>`;
    $('prevT').onclick = () => { S.table = (S.table + 9) % 10; closeKey = ''; rightKey = ''; buildCrumb(); };
    $('nextT').onclick = () => { S.table = (S.table + 1) % 10; closeKey = ''; rightKey = ''; buildCrumb(); };
  }
  drawOverhead($('cOv') as HTMLCanvasElement, st, since < 1 && !waiting ? since : 1, plan.quality);
  drawStanding($('cSd') as HTMLCanvasElement, st, plan.quality);
}

// ---- right panel: facts, legend, table list ------------------------------------------------------
let lastFocusKey = '';
let rightKey = '';
function facts(plan: Plan, st: RoundState, k: number, waiting: boolean): string {
  const nx = st.next;
  return `
    <div class="kv"><span>score</span><span class="score">${scoreText(plan, st, waiting)}</span></div>
    ${plan.mode !== 'single' ? `<div class="kv"><span>tallest stack / raw</span><span>${st.rawScore} coins</span></div>` : ''}
    <div class="kv"><span>coins on table</span><span>${st.coinsOnTable}</span></div>
    <div class="kv"><span>move</span><span>${Math.min(k, plan.moves.length)} / ${plan.moves.length}</span></div>
    <div class="kv"><span>24h volume (locked)</span><span>$${fmt(plan.volumeUsd)}</span></div>
    <div class="kv"><span>coin quality</span><span>${Math.round(plan.quality * 100)}%</span></div>
    <div class="bar"><div style="width:${Math.round(plan.quality * 100)}%"></div></div>
    ${st.status === 'active' ? `<div class="kv"><span>next coin weight off</span><span>${Math.hypot(nx.comX, nx.comY).toFixed(1)} mm</span></div><div class="kv"><span>next coin support</span><span>${Math.round(nx.supportScale * 100)}%</span></div>` : ''}
    ${st.status === 'fell' ? `<div class="kv"><span>fall</span><span class="r">stack ${st.fall?.stack} (${st.fall?.reason})</span></div><div class="kv"><span>fall fee (5%)</span><span>${st.fallFee} play coins</span></div>` : ''}
    <div class="kv"><span>replay check</span><span class="${verified(plan) ? 'g' : 'r'}">${verified(plan) ? 'matches server result' : 'MISMATCH'}</span></div>
    <div class="kv"><span>round id</span></div><code>${plan.roundId}</code>
    <div class="kv"><span>seed</span></div><code>${plan.seed}</code>
    <div class="kv" style="margin-top:6px"><a style="color:var(--accent)" href="/replay/${plan.roundId}" target="_blank" rel="noopener">open replay JSON</a></div>`;
}
function renderFocusTable(plan: Plan, st: RoundState, k: number, waiting: boolean, withCanvases: boolean): void {
  const root = $('focus');
  const key = plan.roundId + ':' + S.mode + ':' + withCanvases + ':' + S.view + S.level;
  if (lastFocusKey !== key) {
    lastFocusKey = key; rightKey = '';
    root.innerHTML = `<h3>${withCanvases ? 'FOCUS' : 'TABLE FACTS'}</h3><div id="fHead"></div>${withCanvases ? '<canvas class="ov"></canvas><canvas class="sd"></canvas>' : ''}<div id="fFacts"></div>`;
  }
  if (withCanvases) { drawOverhead(root.querySelector('.ov') as HTMLCanvasElement, st, 1, plan.quality); drawStanding(root.querySelector('.sd') as HTMLCanvasElement, st, plan.quality); }
  const sstat = status(plan, st, waiting);
  $('fHead').innerHTML = `<div class="kv"><b style="font-size:16px"><span class="dot"></span> ${esc(plan.botName)}</b><span class="badge ${sstat.cls}">${sstat.text}</span></div><div class="kv"><span>table</span><span>${plan.mode} &middot; seat ${plan.seat.index} (A${plan.seat.arena} S${plan.seat.subArena} T${plan.seat.table})</span></div>`;
  $('fFacts').innerHTML = facts(plan, st, k, waiting);
}
function legendHtml(): string {
  const chip = (style: string): string => `<span style="display:inline-block;width:18px;height:18px;border-radius:50%;flex:none;${style}"></span>`;
  const b = coinBase(T, 1);
  return `<div class="legend">
    <div>${chip(`background:${T.table};border:2px solid ${T.ring}`)} waiting for its bot to start</div>
    <div>${chip(`background:${b}`)} playing: a bigger disc is a taller stack</div>
    <div>${chip(`background:${b};border:3px solid ${T.cashed}`)} cashed out or connected</div>
    <div>${chip(`background:${T.table};border:3px solid ${T.fell}`)} fell</div>
    <div>${chip(`background:${T.arena};border:2px solid ${T.ring}`)} an arena (10 sub-arenas)</div>
    <div>${chip(`background:${T.subarena};border:2px solid ${T.ring}`)} a sub-arena (10 tables)</div>
    <div>${chip(`background:${T.table};border:2px solid ${T.ring}`)} a table</div>
    <div>${chip(`background:${T.subarena};border:3px dotted ${b}`)} ring of 10 arcs, one per table. Faint = waiting. Coin colour = placing coins (thicker arc = taller stack). Cashed colour = cashed out. Fell colour = fell</div>
    <div>${chip(`background:${T.subarena};border:2px solid ${T.hub};box-shadow:0 0 6px ${T.hub}`)} bright flash: a coin just landed</div>
    <div>${chip(`background:${T.bot};width:10px;height:10px;margin:0 4px`)} a bot disc</div>
  </div>`;
}
function renderRight(rep: TablesReply | null): void {
  const root = $('focus');
  if (S.view === 'grid' || (S.view === 'rings' && S.level === 3)) {
    const plan = rep?.tables[S.table];
    if (!rep || !plan) return;
    const { k, waiting } = progress(rep, plan);
    renderFocusTable(plan, stateAt(plan, k), k, waiting, S.view === 'grid');
    return;
  }
  const now = Math.floor(S.vt / 1500);
  if (S.level === 2 && rep) {
    const key = `L2|${rep.slot}|${S.arena}|${S.sub}|${now}|${T.coin}`;
    if (key === rightKey) return;
    rightKey = key; lastFocusKey = '';
    root.innerHTML = `<h3>SUB-ARENA ${S.arena}.${S.sub}</h3><ul class="tlist">${rep.tables.map((plan, i) => {
      const { k, waiting } = progress(rep, plan); const st = stateAt(plan, k); const s = status(plan, st, waiting);
      return `<li data-t="${i}"><span class="dot"></span><span class="nm">${esc(plan.botName)}</span><span class="badge ${s.cls}">${s.text}</span><span class="score" style="font-size:13px">${scoreText(plan, st, waiting)}</span></li>`;
    }).join('')}</ul><h3 style="margin-top:14px">HOW TO READ THE COLOURS</h3>${legendHtml()}`;
    return;
  }
  const key = `L${S.level}|${S.arena}|${T.coin}|${T.fell}|${T.platform}|${T.arena}|${T.subarena}|${T.table}|${T.cashed}|${T.bot}|${T.ring}`;
  if (key === rightKey) return;
  rightKey = key; lastFocusKey = '';
  root.innerHTML = `<h3>${S.level === 0 ? 'ARENA OF ARENAS' : 'ARENA ' + S.arena}</h3>
    <p style="margin:0 0 10px;color:var(--dim)">${S.level === 0 ? '10 arenas, each with 10 sub-arenas, each with 10 tables: 1,000 tables, every seat held by a house bot. Rounds start at different moments in each minute, so the rings fill up, then settle, then restart.' : 'Each circle is a sub-arena. The small dots inside are its 10 tables.'} Colours update live.</p>
    ${legendHtml()}<p style="margin:12px 0 0;color:var(--dim)">Open the table close-up for the exact stack and a replay check.</p>`;
}

// ---- main loop -----------------------------------------------------------------------------------
let ringVisible = true;
let drawMsAvg = 0, drawCount = 0;
/** Phones and tablets draw fewer frames per second to save battery. */
const frameGap = (): number => (window.innerWidth < 760 || window.matchMedia?.('(pointer:coarse)').matches ? 83 : 50);
function frame(): void {
  try {
    if (!document.hidden) {
      tickClock();
      const slot = Math.floor(S.vt / S.slotMs);
      const needPlans = S.view === 'grid' || S.level >= 2;
      let rep: TablesReply | null = null;
      if (needPlans) {
        loadSlot(slot).catch(() => {});
        rep = repStore.get(keyOf(slot)) ?? null;
        if ((S.vt % S.slotMs) > S.slotMs - 12000) loadSlot(slot + 1).catch(() => {});
      }
      // draw only what is on screen, and when paused only when something changed
      const idle = S.paused && !S.dirty && !S.anim;
      if (S.view === 'grid') { if (rep && !idle) updateGrid(rep); }
      else if (S.level < 3) {
        if (ringVisible && !idle) {
          const t0 = performance.now();
          drawStage(rep);
          drawMsAvg += performance.now() - t0; drawCount++;
          if (drawCount >= 20) { document.documentElement.dataset.drawMs = (drawMsAvg / drawCount).toFixed(1); drawMsAvg = 0; drawCount = 0; }
        }
      } else if (!idle) updateClose(rep);
      S.dirty = false;
      renderRight(rep);
    }
  } catch (e) { console.error(e); }
  requestAnimationFrame(() => setTimeout(frame, frameGap()));
}

// ---- summary: stats strip, telemetry, leaderboard ----------------------------------------------
let summaryBusy = false;
async function refreshSummary(): Promise<void> {
  if (summaryBusy) return;
  summaryBusy = true;
  try {
    const r = await fetch(`/demo/summary?mode=${S.mode}&vol=${S.vol}`);
    if (r.ok) { S.summary = (await r.json()) as Summary; renderSummary(); }
  } catch { /* try again on the next poll */ }
  summaryBusy = false;
}
function renderSummary(): void {
  const s = S.summary; if (!s) return;
  const last = s.lastSlotStats;
  const stats: [string, string, string][] = [
    ['Bots playing', fmt(s.botsPlaying), ''], ['Tables live', fmt(s.tablesLive), 't'], ['Rounds finished', fmt(s.roundsFinished), ''],
    ['Falls', fmt(s.falls), 'r'], ['Cashed out', fmt(s.cashedOut), 'g'],
    ...(S.mode === 'single' ? [] : ([['Stacks connected', fmt(s.connected), 't']] as [string, string, string][])),
    ['Coins stacked', fmt(s.coinsStacked), ''], ['Best score', `${s.board[0]?.score ?? 0} ${unit(S.mode)}`, 'y'],
    ['24h volume', '$' + fmt(s.volumeUsd), 'y'], ['Coin quality', Math.round(s.quality * 100) + '%', 'g'],
  ];
  $('strip').innerHTML = stats.map(([a, b, c]) => `<div class="stat"><i>${a}</i><b class="${c}">${b}</b></div>`).join('');
  $('teleBody').innerHTML = `
    <div class="kv"><span>Mode</span><span>${S.mode}</span></div>
    <div class="kv"><span>Seats</span><span>1,000 (10x10x10)</span></div>
    <div class="kv"><span>Last minute: falls</span><span class="r">${last.falls}</span></div>
    <div class="kv"><span>Last minute: cashed</span><span class="g">${last.cashedOut}</span></div>
    ${S.mode === 'single' ? '' : `<div class="kv"><span>Last minute: connected</span><span class="t">${last.connected}</span></div>`}
    <div class="kv"><span>Last minute: avg score</span><span class="y">${last.avgScore}</span></div>
    <div class="kv"><span>Live CAPH volume</span><span>$${fmt(s.liveVolumeUsd)}</span></div>
    <div class="bar"><div style="width:${Math.round(s.quality * 100)}%"></div></div>
    <div style="color:var(--dim);font-size:11px">Coin quality ${Math.round(s.quality * 100)}%: ${s.quality < 0.25 ? 'worst coins, wobbly and lopsided' : s.quality < 0.75 ? 'middling coins' : 'near perfect coins'}. Volume is locked when each round starts.</div>
    <div style="color:var(--dim);font-size:11px;margin-top:6px">Counts include only minutes when someone was watching.${s.updating ? ' Updating...' : ''}</div>`;
  const lb = $('lb');
  lb.innerHTML = s.board.map((e, i) => `<li data-seat="${e.seat}"><span class="n">${i + 1}</span><span class="dot"></span><span class="nm">${esc(e.botName)}</span><span class="tag">HOUSE</span><span class="sc">${e.score}</span></li>`).join('') || '<li style="color:var(--dim)">counting the first minute...</li>';
  lb.querySelectorAll('li[data-seat]').forEach((li) => li.addEventListener('click', () => goSeat(Number((li as HTMLElement).dataset.seat))));
}
function goSeat(seat: number): void {
  const a = Math.floor(seat / 100), s = Math.floor(seat / 10) % 10, t = seat % 10;
  if (S.view === 'rings') go(3, a, s, t);
  else { S.arena = a; S.sub = s; S.table = t; buildControls(); buildCrumb(); syncSel(); lastFocusKey = ''; }
}

// ---- colour panel ------------------------------------------------------------------------------------
const LEVEL_ROWS: { key: ThemeColorKey; label: string; hint: string }[] = [
  { key: 'arena', label: 'Main arena color', hint: 'the 10 big arena circles' },
  { key: 'subarena', label: 'Sub-arena color', hint: 'the circles inside an arena, and the slab under a table close-up' },
  { key: 'table', label: 'Table color', hint: 'the table circles and the surface a stack stands on' },
];
const COLOR_ROWS: { key: ThemeColorKey; label: string; hint: string }[] = [
  { key: 'bg', label: 'Background', hint: 'behind everything' },
  { key: 'text', label: 'Text', hint: 'words and numbers' },
  { key: 'coin', label: 'Coins', hint: 'the coin colour (best quality when blending)' },
  { key: 'coin2', label: 'Coins, worst quality', hint: 'used when colouring by quality' },
  { key: 'platform', label: 'Platform (big circle)', hint: 'the big circle behind the 10 arenas' },
  { key: 'ring', label: 'Rings and outlines', hint: 'circle edges' },
  { key: 'hub', label: 'Hub text and highlights', hint: 'hub words, selection' },
  { key: 'hubFill', label: 'Hub fill', hint: 'the Collection Center Hub' },
  { key: 'bot', label: 'Bot discs', hint: 'the small disc by each bot name' },
  { key: 'fell', label: 'Fell marks', hint: 'a stack that fell' },
  { key: 'cashed', label: 'Cashed out marks', hint: 'a round that was cashed out' },
];
function buildColors(): void {
  const box = $('colors');
  box.innerHTML = `<h3>COLORS <button id="cClose" style="padding:2px 10px">X</button></h3>
    <div class="sec">PRESETS</div><div id="presets"></div>
    <div class="sec">LEVELS</div><div id="lrows"></div>
    <div class="sec">COINS</div>
    <div class="crow"><label for="cq">Colour coins by quality<small>blend from worst to best coin colour</small></label><input type="checkbox" id="cq"></div>
    <div class="sec">COLOURS</div><div id="crows"></div>
    <div class="btns"><button id="cShare">COPY SHARE LINK</button><button id="cReset">RESET</button></div>
    <div id="shareMsg"></div>`;
  const pr = $('presets');
  PRESETS.forEach((p) => {
    const b = document.createElement('button');
    b.innerHTML = `<i><b style="background:${p.theme.bg};border:1px solid ${p.theme.ring}"></b><b style="background:${p.theme.arena}"></b><b style="background:${p.theme.subarena}"></b><b style="background:${p.theme.table}"></b><b style="background:${p.theme.coin}"></b><b style="background:${p.theme.hub}"></b></i>${p.name}`;
    b.onclick = () => setTheme(p.theme);
    b.dataset.preset = p.id;
    pr.appendChild(b);
  });
  const rnd = document.createElement('button');
  rnd.id = 'cRandom'; rnd.textContent = 'RANDOM'; rnd.title = 'Pick every colour at random (press again for another)';
  rnd.onclick = () => { setTheme(randomTheme(Math.random)); $('shareMsg').textContent = 'Random colours. Press RANDOM again for another set, or RESET to go back.'; };
  pr.appendChild(rnd);
  const addRow = (rows: HTMLElement, r: { key: ThemeColorKey; label: string; hint: string }): void => {
    const d = document.createElement('div');
    d.className = 'crow'; d.dataset.key = r.key;
    d.innerHTML = `<label>${r.label}<small>${r.hint}</small></label><input type="text" maxlength="7" spellcheck="false" data-hex="${r.key}"><input type="color" data-pick="${r.key}">`;
    rows.appendChild(d);
    const pick = d.querySelector('input[type=color]') as HTMLInputElement, txt = d.querySelector('input[type=text]') as HTMLInputElement;
    pick.oninput = () => setTheme({ [r.key]: pick.value } as Partial<Theme>);
    txt.onchange = () => { const h = normHex(txt.value); if (h) setTheme({ [r.key]: h } as Partial<Theme>); else syncColorInputs(); };
  };
  LEVEL_ROWS.forEach((r) => addRow($('lrows'), r));
  COLOR_ROWS.forEach((r) => addRow($('crows'), r));
  ($('cq') as HTMLInputElement).onchange = (e) => setTheme({ coinByQuality: (e.target as HTMLInputElement).checked });
  $('cReset').onclick = () => { setTheme(DEFAULT_THEME); $('shareMsg').textContent = 'Back to black, white and red.'; };
  $('cClose').onclick = () => toggleColors(false);
  $('cShare').onclick = async () => {
    const url = `${location.origin}${location.pathname}${withHashParam(withHashParam(location.hash, 'theme', themeToHash(T).slice(6)), 'text', S.text ? null : 'off')}`;
    try { await navigator.clipboard.writeText(url); $('shareMsg').textContent = 'Link copied. Anyone who opens it gets these colours.'; }
    catch { $('shareMsg').textContent = url; }
    history.replaceState(null, '', location.pathname + location.search + withHashParam(location.hash, 'theme', themeToHash(T).slice(6)));
  };
  syncColorInputs();
}
function syncColorInputs(): void {
  const box = document.getElementById('colors'); if (!box || !box.firstChild) return;
  for (const k of THEME_KEYS) {
    const p = box.querySelector(`input[data-pick="${k}"]`) as HTMLInputElement | null, t = box.querySelector(`input[data-hex="${k}"]`) as HTMLInputElement | null;
    if (p && p.value !== T[k]) p.value = T[k];
    if (t && document.activeElement !== t) t.value = T[k];
  }
  const cq = box.querySelector('#cq') as HTMLInputElement | null; if (cq) cq.checked = T.coinByQuality;
  const row2 = box.querySelector('[data-key="coin2"]') as HTMLElement | null; if (row2) row2.style.opacity = T.coinByQuality ? '1' : '0.45';
  box.querySelectorAll('#presets button').forEach((b) => { const p = PRESETS.find((x) => x.id === (b as HTMLElement).dataset.preset); (b as HTMLElement).className = p && sameTheme(p.theme, T) ? 'on' : ''; });
}
function toggleColors(show?: boolean): void {
  const box = $('colors');
  const on = show ?? !box.classList.contains('show');
  box.classList.toggle('show', on);
  $('colorBtn').className = on ? 'on' : '';
}

// ---- footer, info -------------------------------------------------------------------------------------
function showInfo(): void {
  $('modalBox').innerHTML = `<h2>HOW TO READ THIS</h2>
    <p>This is a <b>watch-only demo</b> of the CAPHET Arena. Each mode has 1,000 seats: <b>10 arenas, each with 10 sub-arenas, each with 10 tables</b>. Every seat is always playing a <b>house bot</b> with <b>play coins</b>. Nobody can join, and no wallet or real token is involved.</p>
    <p><b>Arena of arenas:</b> the top view is the Collection Center Hub with a ring of 10 arenas around it. On the top view every arena shows its 10 sub-arenas, and each sub-arena shows its 10 tables as a ring of 10 arcs that light up as bots place coins, with a disc that grows in the middle. Tap an arena to see its 10 sub-arenas with every table as a live dot, tap a sub-arena to see its 10 tables, tap a table for the close-up. The BACK button, the trail at the top, or tapping the hub takes you out again. The TABLE GRID button shows the older ten-card layout.</p>
    <p>A coin is 63.5 mm wide. Bots slide each new coin sideways. In <b>single</b> the score is how far (mm) the stack reaches out from the first coin. In <b>twin</b> and <b>triple</b> the stacks must touch each other and the score is the tallest stack in coins (capped at the second tallest plus 10). If the stack tips over it <b>falls</b>.</p>
    <p>Coin quality comes from live CAPH trading volume: at $500 or less coins are lopsided and wobbly, at $100,000 or more they are perfect. Use the volume menu to see what better or worse coins look like.</p>
    <p>Every table close-up is a real engine round. The server sends the seed, the volume and the moves. <b>Your browser replays them with the same engine</b> and checks the result (see "replay check"). The two outer views are a quick live picture made from each table's start time, speed and result, so they are approximate; the table views are exact.</p>
    <p>Use <b>COLORS</b> to change every colour and save it in this browser. <b>TEXT: ON/OFF</b> hides every label on the hub, arenas, sub-arenas and tables so only the pure picture shows.</p>
    <p><button onclick="document.getElementById('modal').classList.remove('show')">CLOSE</button></p>`;
  $('modal').classList.add('show');
}
/** Show or hide every label drawn on the hub, arenas, sub-arenas and tables. Saved in the browser and in the URL hash. */
function setText(on: boolean, save = true): void {
  S.text = on; S.dirty = true; closeKey = '';
  const b = $('textBtn'); b.textContent = on ? 'TEXT: ON' : 'TEXT: OFF'; b.className = on ? '' : 'on'; b.setAttribute('aria-pressed', String(!on));
  if (!save) return;
  try { localStorage.setItem(TEXT_STORE, on ? '1' : '0'); } catch { /* private mode */ }
  history.replaceState(null, '', location.pathname + location.search + withHashParam(location.hash, 'text', on ? null : 'off'));
}
function loadText(): void {
  let v: boolean | null = textFlagFromHash(location.hash);
  const fromHash = v !== null;
  if (v === null) { try { v = textFlagFromStore(localStorage.getItem(TEXT_STORE)); } catch { v = null; } }
  setText(v ?? true, fromHash);
}
function buildFooter(): void {
  $('pause').onclick = () => { S.paused = !S.paused; buildControls(); };
  $('follow').onclick = () => { const e = S.summary?.board[0]; if (e) goSeat(e.seat); };
  $('back').onclick = up;
  $('colorBtn').onclick = () => toggleColors();
  $('textBtn').onclick = () => setText(!S.text);
  $('info').onclick = showInfo;
  $('modal').onclick = (e) => { if (e.target === $('modal')) $('modal').classList.remove('show'); };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if ($('modal').classList.contains('show')) $('modal').classList.remove('show'); else if ($('colors').classList.contains('show')) toggleColors(false); else up(); } });
  const ring = $('ring');
  ring.addEventListener('pointermove', onStagePointer);
  ring.addEventListener('pointerleave', () => { S.hover = -1; $('hover').innerHTML = ''; });
  ring.addEventListener('click', onStageClick);
  if (typeof IntersectionObserver !== 'undefined') new IntersectionObserver((es) => { ringVisible = es.some((e) => e.isIntersecting); S.dirty = true; }).observe(ring);
  window.addEventListener('resize', () => { S.dirty = true; });
}
/** A link like /#go=3.5.2 opens arena 3, sub-arena 5, table 2 (handy for sharing and tests). */
function startFromHash(): void {
  const m = /(?:^|[#&])go=(\d)(?:\.(\d))?(?:\.(\d))?/.exec(location.hash);
  if (!m) return;
  const a = Number(m[1]);
  if (m[3] !== undefined) go(3, a, Number(m[2]), Number(m[3]));
  else if (m[2] !== undefined) go(2, a, Number(m[2]));
  else go(1, a);
  S.anim = null;
}

async function boot(): Promise<void> {
  loadTheme();
  try { S.config = await (await fetch('/demo/config')).json(); S.clockOffset = S.config.serverNow - Date.now(); S.slotMs = S.config.slotMs; } catch { /* use defaults */ }
  buildControls(); buildGrid(); buildFooter(); buildColors(); loadText();
  startFromHash();
  buildCrumb(); applyViewClasses();
  refreshSummary();
  setInterval(refreshSummary, 12000);
  frame();
}
boot();

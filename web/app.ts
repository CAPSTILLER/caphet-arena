// Browser side of the watch-only demo. Bundled with the real engine so the browser replays every round itself.
import { cashOut, createRound, placeCoin } from '../src/engine.js';
import type { Mode, Move, RoundState } from '../src/types.js';

type Plan = {
  roundId: string; mode: Mode; seat: { index: number; arena: number; subArena: number; table: number }; slot: number; botName: string; archetype: string;
  seed: string; volumeUsd: number; quality: number; moves: Move[]; startDelayMs: number; stepMs: number;
  result: { status: string; score: number; rawScore: number; coinsOnTable: number; fallFee: number };
};
type TablesReply = { slot: number; slotStartMs: number; slotMs: number; volumeUsd: number; quality: number; volumeSource: string; serverNow: number; tables: Plan[] };
type Entry = { botName: string; mode: Mode; seat: number; score: number; rawScore: number; roundId: string; slot: number };
type Summary = Record<string, any> & { board: Entry[] };

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const MODES: Mode[] = ['single', 'twin', 'triple'];
const SPEEDS = [0.5, 1, 2, 4];
const HUES = [44, 190, 318];
const COIN_R = 31.75;
const COIN_T = 3;
const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');

const S = {
  mode: 'single' as Mode, arena: 0, sub: 0, vol: 'live', table: 0,
  speed: 1, paused: false, vt: 0, lastReal: 0, clockOffset: 0, serverSlot: 0, slotMs: 60000,
  config: null as any, summary: null as Summary | null,
};

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
      return j;
    });
    p.catch(() => planCache.delete(k));
    planCache.set(k, p);
    if (planCache.size > 40) planCache.delete(planCache.keys().next().value!);
  }
  return p;
}

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
// ---- drawing -------------------------------------------------------------------------------
function fit(cv: HTMLCanvasElement, h?: number): CanvasRenderingContext2D {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(60, Math.floor(cv.clientWidth * dpr));
  const hh = h ? Math.floor(h * dpr) : w;
  if (cv.width !== w || cv.height !== hh) { cv.width = w; cv.height = hh; }
  return cv.getContext('2d')!;
}
const css = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function coinPath(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); }

function drawOverhead(cv: HTMLCanvasElement, st: RoundState, fresh: number): void {
  const ctx = fit(cv);
  const w = cv.width;
  ctx.clearRect(0, 0, w, w);
  // single stacks only reach about 100 mm, so zoom in on the middle of the big table; twin and triple show the whole table
  let viewR = st.tableRadiusMm;
  if (st.mode === 'single') {
    let far = 0;
    for (const c of st.stacks[0]!) far = Math.max(far, Math.hypot(c.x - st.homes[0]!.x, c.y - st.homes[0]!.y));
    viewR = Math.min(st.tableRadiusMm, Math.max(120, far + COIN_R + 30));
  }
  const scale = (w / 2 - 4) / viewR;
  const cx = w / 2, cy = w / 2;
  const P = (x: number, y: number): [number, number] => [cx + (x - st.tableCenter.x) * scale, cy + (y - st.tableCenter.y) * scale];
  // table
  const bg = css('--bg');
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(10, st.tableRadiusMm * scale));
  g.addColorStop(0, 'rgba(35,213,196,0.10)'); g.addColorStop(1, 'rgba(35,213,196,0.03)');
  const tr = st.tableRadiusMm * scale;
  coinPath(ctx, cx, cy, tr); ctx.fillStyle = g; ctx.fill();
  ctx.strokeStyle = 'rgba(35,213,196,0.55)'; ctx.lineWidth = 2; ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1;
  for (let rr = 50; rr < st.tableRadiusMm; rr += 50) { coinPath(ctx, cx, cy, rr * scale); ctx.stroke(); }
  // homes
  ctx.setLineDash([4, 4]); ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  for (const h of st.homes) { const [x, y] = P(h.x, h.y); coinPath(ctx, x, y, COIN_R * scale); ctx.stroke(); }
  ctx.setLineDash([]);
  // touching stacks
  st.pairs.forEach((pr, i) => {
    if (!st.touching[i]) return;
    const a = st.homes[pr[0]]!, b = st.homes[pr[1]]!;
    const [x1, y1] = P(a.x, a.y), [x2, y2] = P(b.x, b.y);
    ctx.strokeStyle = 'rgba(35,213,196,0.9)'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  });
  // coins, bottom to top
  st.stacks.forEach((stack, si) => {
    const hue = st.mode === 'single' ? HUES[0]! : HUES[si % 3]!;
    stack.forEach((c, i) => {
      const [x, y] = P(c.x, c.y);
      const r = COIN_R * scale;
      const lift = Math.min(10, i * 0.5) * (w / 400);
      const topIdx = i === stack.length - 1;
      const pop = topIdx ? Math.min(1, fresh) : 1;
      ctx.save();
      ctx.translate(0, -lift);
      ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 5 * (w / 400); ctx.shadowOffsetY = 2 * (w / 400);
      const rr = r * (0.6 + 0.4 * pop);
      const grad = ctx.createRadialGradient(x - rr * 0.35, y - rr * 0.35, rr * 0.1, x, y, rr);
      const l = 34 + Math.min(30, i * 2.2);
      grad.addColorStop(0, `hsl(${hue} 90% ${l + 22}%)`); grad.addColorStop(1, `hsl(${hue} 80% ${l}%)`);
      coinPath(ctx, x, y, rr); ctx.fillStyle = grad; ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.strokeStyle = `hsl(${hue} 70% ${l - 14}%)`; ctx.lineWidth = Math.max(1, rr * 0.07); ctx.stroke();
      coinPath(ctx, x, y, rr * 0.68); ctx.strokeStyle = `hsla(${hue} 90% ${l + 26}%,0.55)`; ctx.lineWidth = Math.max(1, rr * 0.05); ctx.stroke();
      if (topIdx && st.status === 'fell' && st.fall?.stack === si) { coinPath(ctx, x, y, rr + 2); ctx.strokeStyle = css('--red'); ctx.lineWidth = 3; ctx.stroke(); }
      else if (topIdx && st.status === 'active') { coinPath(ctx, x, y, rr + 2); ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1.5; ctx.stroke(); }
      ctx.restore();
    });
  });
  void bg;
}

function drawSide(cv: HTMLCanvasElement, st: RoundState): void {
  const hCss = 210;
  const ctx = fit(cv, hCss);
  const w = cv.width, h = cv.height;
  ctx.clearRect(0, 0, w, h);
  let minX = Infinity, maxX = -Infinity, maxN = 1;
  st.stacks.forEach((s) => { maxN = Math.max(maxN, s.length); s.forEach((c) => { minX = Math.min(minX, c.x - COIN_R); maxX = Math.max(maxX, c.x + COIN_R); }); });
  for (const home of st.homes) { minX = Math.min(minX, home.x - COIN_R); maxX = Math.max(maxX, home.x + COIN_R); }
  const pad = 20;
  const th = COIN_T * 2.4; // thickness exaggerated for display
  const sx = (w - 2 * pad) / Math.max(120, maxX - minX);
  const sy = (h - 2 * pad) / Math.max(10 * th, maxN * th);
  const s = Math.min(sx, sy * 1.0);
  const x0 = w / 2 - ((minX + maxX) / 2) * s;
  const base = h - pad;
  ctx.strokeStyle = 'rgba(35,213,196,0.6)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(pad / 2, base + 1); ctx.lineTo(w - pad / 2, base + 1); ctx.stroke();
  st.stacks.forEach((stack, si) => {
    const hue = st.mode === 'single' ? HUES[0]! : HUES[si % 3]!;
    stack.forEach((c, i) => {
      const x = x0 + c.x * s, y = base - (i + 1) * th * s;
      const l = 36 + Math.min(28, i * 2);
      ctx.fillStyle = `hsl(${hue} 80% ${l}%)`; ctx.strokeStyle = `hsl(${hue} 70% ${l - 15}%)`; ctx.lineWidth = 1;
      const r = Math.min(3, th * s * 0.45);
      ctx.beginPath(); ctx.roundRect(x - COIN_R * s, y, 2 * COIN_R * s, th * s * 0.92, r); ctx.fill(); ctx.stroke();
    });
  });
  ctx.fillStyle = 'rgba(219,230,255,0.55)'; ctx.font = `${11 * (w / 330)}px ui-monospace,monospace`;
  ctx.fillText('side view, coin thickness drawn 2.4x', pad, 14 * (w / 330));
}

// ---- UI --------------------------------------------------------------------------------------
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

function buildControls(): void {
  const modes = $('modes');
  modes.innerHTML = '';
  MODES.forEach((m) => { const b = document.createElement('button'); b.textContent = m; b.className = m === S.mode ? 'on' : ''; b.onclick = () => { S.mode = m; S.summary = null; afterSelect(); }; modes.appendChild(b); });
  for (const [id, key] of [['arenas', 'arena'], ['subs', 'sub']] as const) {
    const wrap = $(id); wrap.innerHTML = '';
    for (let i = 0; i < 10; i++) { const b = document.createElement('button'); b.textContent = String(i); b.className = S[key] === i ? 'on' : ''; b.onclick = () => { S[key] = i; afterSelect(); }; wrap.appendChild(b); }
  }
  $('crumb').innerHTML = `<b>${S.mode}</b> &gt; arena <b>${S.arena}</b> &gt; sub-arena <b>${S.sub}</b> &gt; tables <b>${S.arena * 100 + S.sub * 10}-${S.arena * 100 + S.sub * 10 + 9}</b>`;
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
function afterSelect(): void { S.table = Math.min(S.table, 9); buildControls(); syncSel(); lastFocusKey = ''; refreshSummary(); }

let lastFocusKey = '';
function renderFocus(plan: Plan, st: RoundState, k: number, waiting: boolean): void {
  const root = $('focus');
  const key = plan.roundId + ':' + (S.mode);
  if (lastFocusKey !== key) {
    lastFocusKey = key;
    root.innerHTML = `<h3>FOCUS</h3><div id="fHead"></div><canvas class="ov"></canvas><canvas class="sd"></canvas><div id="fFacts"></div>`;
  }
  const ov = root.querySelector('.ov') as HTMLCanvasElement, sd = root.querySelector('.sd') as HTMLCanvasElement;
  drawOverhead(ov, st, 1); drawSide(sd, st);
  const sstat = status(plan, st, waiting);
  const nx = st.next;
  $('fHead').innerHTML = `<div class="kv"><b style="font-size:16px">${plan.botName}</b><span class="badge ${sstat.cls}">${sstat.text}</span></div><div class="kv"><span>table</span><span>${plan.mode} &middot; seat ${plan.seat.index} (A${plan.seat.arena} S${plan.seat.subArena} T${plan.seat.table})</span></div>`;
  $('fFacts').innerHTML = `
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
    <div class="kv" style="margin-top:6px"><a style="color:var(--teal)" href="/replay/${plan.roundId}" target="_blank" rel="noopener">open replay JSON</a></div>`;
}

function frame(): void {
  tickClock();
  const slot = Math.floor(S.vt / S.slotMs);
  loadSlot(slot).then((rep) => {
    if (keyOf(slot) !== keyOf(Math.floor(S.vt / S.slotMs))) return;
    const toNext = rep.slotStartMs + rep.slotMs - S.vt;
    if (toNext < 12000) loadSlot(slot + 1).catch(() => {});
    rep.tables.forEach((plan, i) => {
      const c = cards[i]; if (!c) return;
      const t = S.vt - rep.slotStartMs - plan.startDelayMs;
      const waiting = t < 0;
      const k = waiting ? 0 : Math.min(plan.moves.length, Math.floor(t / plan.stepMs) + 1);
      const st = stateAt(plan, k);
      const since = waiting ? 0 : (t - (k - 1) * plan.stepMs) / 350; // newest coin pops in
      const animating = since < 1 && k < plan.moves.length + 1 && !waiting;
      if (c.lastK !== k || c.lastId !== plan.roundId || animating) {
        if (c.lastId !== plan.roundId) c.top.textContent = plan.botName;
        c.lastK = k; c.lastId = plan.roundId;
        drawOverhead(c.cv, st, animating ? since : 1);
        const s = status(plan, st, waiting);
        c.badge.className = 'badge ' + s.cls; c.badge.textContent = s.text;
        c.score.textContent = scoreText(plan, st, waiting);
        c.coins.textContent = `${st.coinsOnTable} coins`;
        (c.el.querySelector('.q') as HTMLElement).textContent = `Q ${Math.round(plan.quality * 100)}%`;
      }
      if (i === S.table) renderFocus(plan, st, k, waiting);
    });
  }).catch(() => {});
  requestAnimationFrame(() => setTimeout(frame, 50));
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
  lb.innerHTML = s.board.map((e, i) => `<li data-seat="${e.seat}"><span class="n">${i + 1}</span><span class="nm">${e.botName}</span><span class="tag">HOUSE</span><span class="sc">${e.score}</span></li>`).join('') || '<li style="color:var(--dim)">counting the first minute...</li>';
  lb.querySelectorAll('li[data-seat]').forEach((li) => li.addEventListener('click', () => goSeat(Number((li as HTMLElement).dataset.seat))));
}
function goSeat(seat: number): void {
  S.arena = Math.floor(seat / 100); S.sub = Math.floor(seat / 10) % 10; S.table = seat % 10;
  buildControls(); syncSel(); lastFocusKey = '';
}

// ---- footer: theme, follow, info ---------------------------------------------------------------
function setBg(c: string): void {
  document.documentElement.style.setProperty('--bg', c);
  document.body.style.background = c;
  try { localStorage.setItem('caphet-bg', c); } catch { /* private mode */ }
  ($('bg') as HTMLInputElement).value = c;
}
function buildFooter(): void {
  const sw = $('swatches'); sw.innerHTML = '';
  for (const c of ['#070b16', '#000000', '#0d1b12', '#1a0d24', '#2a1a0a', '#e9eef8']) {
    const b = document.createElement('button'); b.className = 'swatch'; b.style.background = c; b.title = c; b.onclick = () => setBg(c); sw.appendChild(b);
  }
  ($('bg') as HTMLInputElement).oninput = (e) => setBg((e.target as HTMLInputElement).value);
  $('pause').onclick = () => { S.paused = !S.paused; buildControls(); };
  $('follow').onclick = () => { const e = S.summary?.board[0]; if (e) goSeat(e.seat); };
  $('info').onclick = () => { $('modalBox').innerHTML = `<h2>HOW TO READ THIS</h2>
    <p>This is a <b>watch-only demo</b> of the CAPHET Arena. Each mode has 1,000 seats (10 arenas x 10 sub-arenas x 10 tables). Every seat is always playing a <b>house bot</b> with <b>play coins</b>. Nobody can join, and no wallet or real token is involved.</p>
    <p>A coin is 63.5 mm wide. Bots slide each new coin sideways. In <b>single</b> the score is how far (mm) the stack reaches out from the first coin. In <b>twin</b> and <b>triple</b> the stacks must touch each other and the score is the tallest stack in coins (capped at the second tallest plus 10). If the stack tips over it <b>falls</b>.</p>
    <p>Coin quality comes from live CAPH trading volume: at $500 or less coins are lopsided and wobbly, at $100,000 or more they are perfect. Use the volume menu to see what better or worse coins look like.</p>
    <p>Every round is a real engine round. The server sends the seed, the volume and the moves. <b>Your browser replays them with the same engine</b> and checks the result (see "replay check" in the focus panel). The same round id gives the same round on any machine.</p>
    <p><button onclick="document.getElementById('modal').classList.remove('show')">CLOSE</button></p>`; $('modal').classList.add('show'); };
  $('modal').onclick = (e) => { if (e.target === $('modal')) $('modal').classList.remove('show'); };
  try { const c = localStorage.getItem('caphet-bg'); if (c) setBg(c); } catch { /* ignore */ }
}

async function boot(): Promise<void> {
  try { S.config = await (await fetch('/demo/config')).json(); S.clockOffset = S.config.serverNow - Date.now(); S.slotMs = S.config.slotMs; } catch { /* use defaults */ }
  buildControls(); buildGrid(); buildFooter();
  refreshSummary();
  setInterval(refreshSummary, 12000);
  frame();
}
boot();

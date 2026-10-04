/**
 * Balance simulation: 1000 house bot rounds per mode, archetypes and volume tiers rotating.
 * Usage: npx tsx scripts/sim.ts [roundsPerMode]
 */
import { ARCHETYPES, canPlayMode, playHouseRound, qualityFromVolume, settleRound, verifyRecord, type Mode, type RoundState } from '../src/index.js';

const N = Number(process.argv[2] ?? 1000);
const MODES: Mode[] = ['single', 'twin', 'triple'];
const VOLUMES = [0, 500, 5_000, 30_000, 100_000];

interface Row {
  rounds: number;
  fell: number;
  cashed: number;
  touched: number;
  maxed: number;
  scores: number[];
  coins: number;
  fees: number;
}
const blank = (): Row => ({ rounds: 0, fell: 0, cashed: 0, touched: 0, maxed: 0, scores: [], coins: 0, fees: 0 });
function add(r: Row, s: RoundState): void {
  r.rounds++;
  r[s.status === 'active' ? 'maxed' : s.status]++;
  r.scores.push(s.score);
  r.coins += s.coinsOnTable;
  r.fees += s.fallFee;
}
const pct = (a: number[], p: number): number => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
};
const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const f = (v: number, d = 1): string => v.toFixed(d);
function line(label: string, r: Row): string {
  const paid = r.scores.filter((x) => x > 0);
  return (
    `${label.padEnd(22)} n=${String(r.rounds).padStart(4)} fall=${f((100 * r.fell) / r.rounds).padStart(5)}% ` +
    `touch=${f((100 * r.touched) / r.rounds).padStart(5)}% cash=${f((100 * r.cashed) / r.rounds).padStart(5)}% ` +
    `zero=${f((100 * (r.rounds - paid.length)) / r.rounds).padStart(5)}% ` +
    `mean=${f(mean(r.scores)).padStart(5)} p50=${String(pct(r.scores, 50)).padStart(3)} p90=${String(pct(r.scores, 90)).padStart(3)} ` +
    `max=${String(Math.max(...r.scores)).padStart(3)} coins=${f(r.coins / r.rounds).padStart(5)} fee=${f(r.fees / r.rounds, 2)}`
  );
}

function ledgerLine(label: string, states: RoundState[], highScore: number): string {
  let toVault = 0;
  let toWallet = 0;
  let toTreasury = 0;
  for (const st of states) {
    const e = settleRound(st, { highScore });
    toVault += e.walletToVault;
    toWallet += e.vaultToWallet;
    toTreasury += e.vaultToTreasury;
  }
  const n = states.length;
  return `${label.padEnd(26)} ante in=${f(toVault / n, 2).padStart(6)} payout out=${f(toWallet / n, 2).padStart(6)} ` +
    `fee vault->treasury=${f(toTreasury / n, 2)} wallet net=${f((toWallet - toVault) / n, 2).padStart(6)} ` +
    `VAULT NET=${f((toVault - toWallet - toTreasury) / n, 2).padStart(6)} (tokens per round, + means vault gains)`;
}

let invalid = 0;
for (const mode of MODES) {
  const total = blank();
  const byArche = new Map<string, Row>();
  const byVol = new Map<number, Row>();
  const hist = new Map<string, number>();
  const states: RoundState[] = [];
  for (let i = 0; i < N; i++) {
    const arche = ARCHETYPES[i % ARCHETYPES.length]!;
    const vol = VOLUMES[Math.floor(i / ARCHETYPES.length) % VOLUMES.length]!;
    const { state, record } = playHouseRound({ mode, seed: `sim-${mode}-${i}`, volumeUsd: vol, archetype: arche });
    if (!verifyRecord(record).valid) invalid++;
    states.push(state);
    add(total, state);
    add(byArche.get(arche.id) ?? byArche.set(arche.id, blank()).get(arche.id)!, state);
    add(byVol.get(vol) ?? byVol.set(vol, blank()).get(vol)!, state);
    const bucket = mode === 'single' ? Math.min(150, Math.floor(state.score / 10) * 10) : Math.min(60, Math.floor(state.score / 5) * 5);
    const key = String(bucket).padStart(3);
    hist.set(key, (hist.get(key) ?? 0) + 1);
  }
  console.log(`\n=== ${mode.toUpperCase()} (${N} rounds, scores in ${mode === 'single' ? 'mm' : 'coins'}) ===`);
  console.log(line('ALL', total));
  console.log('-- by archetype');
  for (const a of ARCHETYPES) console.log(line(a.id, byArche.get(a.id)!));
  console.log('-- by 24h volume (quality)');
  for (const v of VOLUMES) console.log(line(`$${v} q=${f(qualityFromVolume(v), 2)}`, byVol.get(v)!));
  console.log('-- expected vault net per round (all 1000 rounds, all volumes; wallet ante = its best score)');
  if (mode === 'single') console.log(ledgerLine('first play wallet (ante 0)', states, 0));
  else console.log('first play wallet: not allowed (twin and triple are locked until a best score exists)');
  for (const ante of [10, 30, 100]) console.log(ledgerLine(`mid wallet (ante ${ante})`, states, ante));
  const states0 = states.filter((st) => st.volumeUsd <= 500);
  console.log(`-- same at today's CAPH volume ($0 to $500, q=0), ${states0.length} rounds`);
  if (mode === 'single') console.log(ledgerLine('first play wallet (ante 0)', states0, 0));
  console.log(ledgerLine('mid wallet (ante 30)', states0, 30));
  console.log(`-- score histogram (bucket start: rounds), width ${mode === 'single' ? 10 : 5}`);
  console.log([...hist.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, v]) => `${k.trim()}:${v}`).join('  '));
}
// ---------------------------------------------------------------------------
// Wallet lifecycle: the same wallet plays once a day for 30 days; ante = best score so far.
// ---------------------------------------------------------------------------
const WALLETS = Number(process.argv[3] ?? 200);
const DAYS = 30;
type Policy = 'single only' | 'single then twin/triple';
for (const policy of ['single only', 'single then twin/triple'] as Policy[]) {
  const dayNet = new Array<number>(DAYS).fill(0);
  const dayFee = new Array<number>(DAYS).fill(0);
  let maxAnte = 0;
  let sumBest = 0;
  for (let w = 0; w < WALLETS; w++) {
    const arche = ARCHETYPES[w % ARCHETYPES.length]!;
    const vol = VOLUMES[Math.floor(w / ARCHETYPES.length) % VOLUMES.length]!;
    let best = 0;
    for (let d = 0; d < DAYS; d++) {
      let mode: Mode = 'single';
      if (policy !== 'single only' && canPlayMode(best, 'twin')) mode = d % 2 === 0 ? 'twin' : 'triple';
      const { state } = playHouseRound({ mode, seed: `life-${policy}-${w}-${d}`, volumeUsd: vol, archetype: arche });
      const e = settleRound(state, { highScore: best });
      dayNet[d]! += e.vaultNet;
      dayFee[d]! += e.vaultToTreasury;
      maxAnte = Math.max(maxAnte, best);
      best = e.newHighScore;
    }
    sumBest += best;
  }
  const first = dayNet[0]! / WALLETS;
  const later = dayNet.slice(1).reduce((a, b) => a + b, 0) / (WALLETS * (DAYS - 1));
  const feeLater = dayFee.slice(1).reduce((a, b) => a + b, 0) / (WALLETS * (DAYS - 1));
  console.log(`\n=== WALLET LIFECYCLE (${WALLETS} house-bot wallets x ${DAYS} daily plays, policy: ${policy}) ===`);
  console.log(`day 1 (free first play) vault net per wallet: ${f(first, 2)}`);
  console.log(`days 2-${DAYS} vault net per wallet-day: ${f(later, 2)}  (treasury fee per wallet-day ${f(feeLater, 2)})`);
  console.log(`30-day vault net per wallet: ${f(dayNet.reduce((a, b) => a + b, 0) / WALLETS, 1)}   avg final best score ${f(sumBest / WALLETS, 1)}  max ante seen ${maxAnte}`);
  console.log(`scaled to 1000 NEW wallets per day: day-1 vault net ${f(first * 1000, 0)} tokens per day just from free first plays`);
  console.log(`scaled to 1000 returning wallets in days 2-${DAYS}: ${f(later * 1000, 0)} tokens per day`);
}

console.log(`\nreplay check: ${invalid} of ${N * MODES.length} records failed verification`);

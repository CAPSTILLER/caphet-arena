/**
 * How much can a smart first-play wallet (ante 0, a fall costs nothing) take from the vault?
 * Tries harmonic lean runs of different lengths and keeps the best average payout.
 * Usage: npx tsx scripts/free-play-farm.ts [rounds]
 */
import { cashOut, createRound, placeCoin, settleRound, type RoundState } from '../src/index.js';
import { harmonicStep, safeOffset } from '../src/bots/helpers.js';

const N = Number(process.argv[2] ?? 300);

function play(seed: string, volume: number, run: number, factor: number, safety: number): RoundState {
  let s = createRound('single', seed, volume);
  for (let j = 1; j <= run && s.status === 'active'; j++) {
    const o = safeOffset(s, 0, { x: 1, y: 0 }, harmonicStep(j, run) * factor, safety);
    s = placeCoin(s, o, 0);
  }
  return s.status === 'active' ? cashOut(s) : s;
}

for (const [label, volume] of [['today ($0 volume, q=0)', 0], ['$5,000 (q=0.43)', 5000], ['$100,000 (q=1)', 100_000]] as const) {
  let best = { ev: -1, run: 0, factor: 0, safety: 0, fall: 0 };
  for (const run of [6, 10, 14, 20, 30, 45, 60]) {
    for (const factor of [0.8, 0.9, 1.0]) {
      for (const safety of [0, 3, 6]) {
        let total = 0;
        let falls = 0;
        for (let i = 0; i < N; i++) {
          const s = play(`farm-${volume}-${i}`, volume, run, factor, safety);
          const e = settleRound(s, { highScore: 0 });
          total += e.payout;
          if (s.status === 'fell') falls++;
        }
        const ev = total / N;
        if (ev > best.ev) best = { ev, run, factor, safety, fall: falls / N };
      }
    }
  }
  console.log(`${label.padEnd(26)} best free first play pays ${best.ev.toFixed(1)} tokens on average (run ${best.run}, factor ${best.factor}, margin ${best.safety} mm, falls ${(best.fall * 100).toFixed(0)}%)`);
}

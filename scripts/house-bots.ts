/**
 * Run the 10 house bots against a running server, through the HTTP API only.
 * Usage: HOUSE_SECRET=... npx tsx scripts/house-bots.ts [baseUrl] [roundsPerBot]
 * Each bot has its own wallet. A bot plays single until it has a best score, then cycles single/twin/triple.
 */
import { ARCHETYPES } from '../src/bots/archetypes.js';
import { houseWallet, playHouseRoundHttp, type HttpRunResult } from '../src/bots/http-runner.js';
import type { Mode } from '../src/types.js';

export async function runHouseBots(baseUrl: string, roundsPerBot: number, houseSecret: string): Promise<HttpRunResult[]> {
  const modes: Mode[] = ['single', 'twin', 'triple'];
  const all: HttpRunResult[] = [];
  await Promise.all(
    ARCHETYPES.map(async (a, idx) => {
      const wallet = houseWallet(a.id);
      let best = 0;
      for (let r = 0; r < roundsPerBot; r++) {
        const mode = best > 0 ? modes[(idx + r) % 3]! : 'single';
        const res = await playHouseRoundHttp({ baseUrl, mode, archetype: a.id, wallet, houseSecret, botSeed: `${a.id}-${r}` });
        best = res.bestScoreAfter;
        all.push(res);
      }
    }),
  );
  return all;
}

if (process.argv[1]?.endsWith('house-bots.ts')) {
  const baseUrl = process.argv[2] ?? 'http://localhost:8787';
  const rounds = Number(process.argv[3] ?? 6);
  const secret = process.env.HOUSE_SECRET ?? '';
  if (!secret) throw new Error('set HOUSE_SECRET (same value the server uses)');
  const results = await runHouseBots(baseUrl, rounds, secret);
  for (const r of results.sort((a, b) => a.archetype.localeCompare(b.archetype))) {
    console.log(`${r.archetype.padEnd(15)} ${r.mode.padEnd(6)} ${r.status.padEnd(8)} score=${String(r.score).padStart(3)} coins=${String(r.coinsOnTable).padStart(3)} ante=${r.ante} payout=${r.payout} fee=${r.vaultToTreasury} best=${r.bestScoreAfter}`);
  }
  console.log(`${results.length} rounds played through ${baseUrl}`);
}

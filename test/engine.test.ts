import { describe, expect, it } from 'vitest';
import {
  ARCHETYPES,
  COIN_DIAMETER_MM,
  COIN_RADIUS_MM,
  EngineError,
  STACK_GAP_MM,
  STACK_SPACING_MM,
  allConnected,
  cashOut,
  createRound,
  fallFee,
  offsetFromPolar,
  offsetToward,
  overhangScoreMm,
  placeCoin,
  playHouseRound,
  previewPlacement,
  qualityFromVolume,
  replay,
  stackMargin,
  teamScore,
  toRecord,
  verifyRecord,
  type Coin,
  type Mode,
  type RoundState,
} from '../src/index.js';

const PERFECT = 100_000; // q = 1: no hand shake, centred weight, full support
const coin = (x: number, y = 0): Coin => ({ x, y, comX: 0, comY: 0, supportScale: 1 });

/** Place a list of offsets on one stack of a perfect-coin round. */
function build(mode: Mode, offsets: (number | { dx: number; dy: number })[], stack = 0, from?: RoundState): RoundState {
  let s = from ?? createRound(mode, 'build', PERFECT);
  for (const o of offsets) s = placeCoin(s, o, stack);
  return s;
}

describe('constants and geometry', () => {
  it('uses a 63.5 mm coin and a 1.5 coin edge gap', () => {
    expect(COIN_DIAMETER_MM).toBe(63.5);
    expect(STACK_GAP_MM).toBe(95.25);
    expect(STACK_SPACING_MM).toBe(158.75);
    const twin = createRound('twin', 1, PERFECT);
    const [a, b] = [twin.stacks[0]![0]!, twin.stacks[1]![0]!];
    expect(b.x - a.x - COIN_DIAMETER_MM).toBeCloseTo(95.25, 9); // edge to edge
    expect(b.y).toBe(a.y);
  });

  it('starts with 1, 2, 3 base coins for the three modes', () => {
    expect(createRound('single', 1, PERFECT).coinsOnTable).toBe(1);
    expect(createRound('twin', 1, PERFECT).coinsOnTable).toBe(2);
    expect(createRound('triple', 1, PERFECT).coinsOnTable).toBe(3);
  });
});

describe('quality scale', () => {
  it('is 0 at or below $500 and 1 at or above $100,000', () => {
    expect(qualityFromVolume(0)).toBe(0);
    expect(qualityFromVolume(500)).toBe(0);
    expect(qualityFromVolume(100)).toBe(0);
    expect(qualityFromVolume(100_000)).toBe(1);
    expect(qualityFromVolume(5_000_000)).toBe(1);
  });
  it('is log scale: the geometric midpoint gives 0.5 and each doubling adds the same', () => {
    expect(qualityFromVolume(Math.sqrt(500 * 100_000))).toBeCloseTo(0.5, 5);
    const d1 = qualityFromVolume(1000) - qualityFromVolume(500);
    const d2 = qualityFromVolume(8000) - qualityFromVolume(4000);
    expect(d1).toBeCloseTo(d2, 5);
  });
  it('rises with volume and handles bad input as worst quality', () => {
    let prev = -1;
    for (const v of [500, 600, 1000, 5000, 20000, 99999, 100000]) {
      const q = qualityFromVolume(v);
      expect(q).toBeGreaterThanOrEqual(prev);
      prev = q;
    }
    expect(qualityFromVolume(Number.NaN)).toBe(0);
    expect(qualityFromVolume(-5)).toBe(0);
  });
  it('locks volume and quality into the round state', () => {
    const s = createRound('single', 7, 7071.07);
    expect(s.volumeUsd).toBe(7071.07);
    expect(s.quality).toBeCloseTo(0.5, 4);
    expect(toRecord(placeCoin(s, 5)).volumeUsd).toBe(7071.07);
  });
  it('quality 1 makes perfect coins, quality 0 makes misshapen ones', () => {
    const good = createRound('single', 'q', PERFECT);
    const goodAll = build('single', [0, 0, 0, 0, 0]);
    for (const c of goodAll.stacks[0]!) {
      expect(c.comX).toBe(0);
      expect(c.comY).toBe(0);
      expect(c.supportScale).toBe(1);
      expect(c.x).toBe(0); // no hand shake either
      expect(c.y).toBe(0);
    }
    expect(good.next).toEqual({ comX: 0, comY: 0, supportScale: 1 });
    // worst coins: lots of centre-of-mass spread, support rim shrinks
    let s = createRound('single', 'bad', 0);
    const coms: number[] = [];
    const scales: number[] = [];
    for (let i = 0; i < 30; i++) {
      coms.push(Math.hypot(s.next.comX, s.next.comY));
      scales.push(s.next.supportScale);
      s = placeCoin(s, 0, 0);
      if (s.status !== 'active') break;
    }
    expect(Math.max(...coms)).toBeGreaterThan(1);
    expect(Math.min(...scales)).toBeLessThan(0.99);
    expect(Math.min(...scales)).toBeGreaterThanOrEqual(0.85);
    expect(Math.max(...coms)).toBeLessThanOrEqual(6.36);
  });
  it('misshapen coins fall more often than perfect ones for the same moves', () => {
    const fallRate = (vol: number): number => {
      let falls = 0;
      for (let i = 0; i < 300; i++) {
        let s = createRound('single', `fr-${i}`, vol);
        for (let k = 0; k < 6 && s.status === 'active'; k++) s = placeCoin(s, 8);
        if (s.status === 'fell') falls++;
      }
      return falls / 300;
    };
    expect(fallRate(0)).toBeGreaterThan(fallRate(PERFECT));
  });
});

describe('determinism and replay', () => {
  it('createRound is pure and repeatable', () => {
    const a = createRound('twin', 'seed-x', 12345);
    const b = createRound('twin', 'seed-x', 12345);
    expect(a).toEqual(b);
    expect(createRound('twin', 'seed-y', 12345)).not.toEqual(a);
  });
  it('placeCoin does not change the state it was given', () => {
    const s = createRound('single', 3, 2000);
    const frozen = JSON.stringify(s);
    const t = placeCoin(s, 10);
    expect(JSON.stringify(s)).toBe(frozen);
    expect(t).not.toBe(s);
    expect(t.moves.length).toBe(1);
  });
  it('the same moves on the same seed give the same result; a different seed can differ', () => {
    const run = (seed: string) => build('single', [], 0, createRound('single', seed, 0)) && placeCoin(createRound('single', seed, 0), 1);
    expect(run('a')).toEqual(run('a'));
    expect(run('a').stacks[0]![1]!.x).not.toBe(run('b').stacks[0]![1]!.x);
  });
  it('replay(seed, mode, volume, moves) reproduces the final state of live play exactly', () => {
    for (const mode of ['single', 'twin', 'triple'] as Mode[]) {
      for (const arche of ARCHETYPES) {
        const { state, record } = playHouseRound({ mode, seed: `det-${mode}-${arche.id}`, volumeUsd: 3000, archetype: arche });
        const r = replay(record.seed, record.mode, record.volumeUsd, JSON.parse(JSON.stringify(record.moves)));
        expect(r.ok).toBe(true);
        expect(r.state).toEqual(state);
        expect(verifyRecord(JSON.parse(JSON.stringify(record))).valid).toBe(true);
      }
    }
  });
  it('house bot rounds are repeatable', () => {
    const o = { mode: 'twin' as const, seed: 'rep', volumeUsd: 50_000, archetype: 'harmonic-long' };
    expect(playHouseRound(o).record).toEqual(playHouseRound(o).record);
  });
  it('replay rejects moves after the round ended and detects tampered records', () => {
    const s = placeCoin(createRound('single', 'r', PERFECT), 50); // falls
    expect(s.status).toBe('fell');
    const r = replay('r', 'single', PERFECT, [...s.moves, { type: 'place', stack: 0, dx: 1, dy: 0 }]);
    expect(r.ok).toBe(false);
    const rec = toRecord(s);
    expect(verifyRecord(rec).valid).toBe(true);
    expect(verifyRecord({ ...rec, score: 99 }).valid).toBe(false);
    expect(verifyRecord({ ...rec, volumeUsd: 1 }).valid).toBe(false);
    expect(verifyRecord({ ...rec, rawScore: 5 }).valid).toBe(false);
  });
  it('string seeds and number seeds both work and differ from each other', () => {
    expect(createRound('single', 5, 0).rng).not.toBe(createRound('single', '5', 0).rng);
    expect(createRound('single', 5, 0)).toEqual(createRound('single', 5, 0));
  });
});

describe('API guard rails', () => {
  it('throws on illegal calls', () => {
    const s = createRound('single', 1, PERFECT);
    expect(() => placeCoin(s, Number.NaN)).toThrow(EngineError);
    expect(() => placeCoin(s, 1, 3)).toThrow(EngineError);
    expect(() => placeCoin(cashOut(s), 1)).toThrow(EngineError);
    expect(() => cashOut(cashOut(s))).toThrow(EngineError);
    expect(() => createRound('single', 1, -1)).toThrow(EngineError);
  });
});

describe('stability', () => {
  it('stands when the weight above stays inside the support coin edge, falls just outside', () => {
    expect(placeCoin(createRound('single', 1, PERFECT), 31.7).status).toBe('active'); // 31.7 < 31.75
    const fell = placeCoin(createRound('single', 1, PERFECT), 31.8); // 31.8 > 31.75
    expect(fell.status).toBe('fell');
    expect(fell.fall).toEqual({ stack: 0, reason: 'unstable' });
    expect(fell.score).toBe(0);
  });
  it('checks the centre of mass of ALL coins above each layer, not just the top coin', () => {
    // coin 2 sits 31.7 over coin 1 (fine), but together coins 1+2 lean 0.5*(31.7+63.4) = 47.5 over the base: falls.
    const s = build('single', [31.7]);
    expect(s.status).toBe('active');
    const t = placeCoin(s, 31.7);
    expect(t.status).toBe('fell');
    // a counterweight on the other side keeps it up
    const ok = build('single', [-20, 31]);
    expect(ok.status).toBe('active');
  });
  it('a coin with weight off centre falls earlier', () => {
    const s = createRound('single', 1, PERFECT);
    const heavy: RoundState = { ...s, next: { comX: 5, comY: 0, supportScale: 1 } };
    expect(placeCoin(heavy, 27).status).toBe('fell'); // 27 + 5 = 32 > 31.75
    expect(placeCoin(heavy, 26).status).toBe('active');
    // weight off centre sideways (y) counts too
    const sideways: RoundState = { ...s, next: { comX: 0, comY: 5, supportScale: 1 } };
    expect(placeCoin(sideways, { dx: 0, dy: 27 }).status).toBe('fell');
    expect(placeCoin(sideways, { dx: 0, dy: 26 }).status).toBe('active');
  });
  it('a shrunken support rim falls earlier', () => {
    const s = createRound('single', 1, PERFECT);
    const base = { ...s, stacks: [[{ x: 0, y: 0, comX: 0, comY: 0, supportScale: 0.85 }]] };
    expect(placeCoin(base, 28).status).toBe('fell'); // 31.75*0.85 = 26.99
    expect(placeCoin(base, 26.9).status).toBe('active');
  });
  it('a coin that leaves the table falls', () => {
    const s = createRound('single', 1, PERFECT);
    const t = placeCoin({ ...s, tableRadiusMm: 10 }, 20);
    expect(t.status).toBe('fell');
    expect(t.fall?.reason).toBe('off_table');
  });
  it('stackMargin and previewPlacement agree with real placement at quality 1', () => {
    const s = createRound('single', 1, PERFECT);
    expect(previewPlacement(s, 0, 30).margin).toBeCloseTo(1.75, 9);
    expect(previewPlacement(s, 0, 33).margin).toBeLessThan(0);
    expect(stackMargin([coin(0)])).toBe(Infinity);
    expect(stackMargin([coin(0), coin(31.75)])).toBeCloseTo(0, 9);
    expect(stackMargin([coin(0), coin(18.7, 25.7)])).toBeCloseTo(31.75 - Math.hypot(18.7, 25.7), 9);
  });
  it('perfect harmonic stack of 4 reaches 58 mm and stands', () => {
    const s = build('single', [10.5, 15.8, 31.7]);
    expect(s.status).toBe('active');
    expect(s.score).toBe(58);
  });
});

describe('mode 1: single stack scoring (whole mm overhang, 1 token per mm)', () => {
  it('scores the whole mm of reach past the base coin edge, rounded down', () => {
    expect(build('single', [20]).score).toBe(20);
    expect(build('single', [20.9]).score).toBe(20);
    expect(build('single', [0, 0, 0]).score).toBe(0);
  });
  it('measures the furthest coin, either side', () => {
    expect(build('single', [-25]).score).toBe(25);
    expect(build('single', [20, -30]).score).toBe(20); // coins at 20 and -10: the furthest is 20, not the last coin
  });
  it('overhangScoreMm is a plain function of the coins', () => {
    expect(overhangScoreMm([coin(5), coin(40.4), coin(12)])).toBe(35);
    expect(overhangScoreMm([])).toBe(0);
  });
  it('cash out keeps the current score; a fall scores 0', () => {
    const s = build('single', [10.5, 15.8, 31.7]);
    const c = cashOut(s);
    expect(c.status).toBe('cashed');
    expect(c.score).toBe(58);
    expect(c.moves.at(-1)).toEqual({ type: 'cashout' });
    expect(c.fallFee).toBe(0);
    const f = placeCoin(s, 40);
    expect(f.status).toBe('fell');
    expect(f.score).toBe(0);
  });
});

describe('mode 2: twin stacks', () => {
  /** Ideal harmonic lean for 4 coins, toward the other stack. */
  const lean = [10.5, 15.8, 31.7];
  it('does not touch at the start and score is 0 if you cash out first', () => {
    const s = createRound('twin', 't', PERFECT);
    expect(s.touching).toEqual([false]);
    expect(s.score).toBe(0);
    const c = cashOut(build('twin', lean, 0, s));
    expect(c.score).toBe(0);
    expect(c.status).toBe('cashed');
    expect(c.fallFee).toBe(0);
  });
  it('ends with the score = coins in the taller stack when the stacks touch', () => {
    let s = build('twin', lean, 0);
    expect(s.status).toBe('active');
    s = build('twin', lean.map((o) => -o), 1, s);
    expect(s.status).toBe('touched');
    expect(s.touching).toEqual([true]);
    expect(s.score).toBe(4);
    expect(() => placeCoin(s, 0, 0)).toThrow(EngineError);
  });
  it('scores the taller stack when heights differ at the touch', () => {
    const s0 = createRound('twin', 't2', PERFECT);
    const tall: Coin[] = [coin(0), coin(0), coin(58.1), coin(0), coin(0), coin(0)]; // 6 coins, layer 2 leans out
    let s: RoundState = { ...s0, stacks: [tall, s0.stacks[1]!], coinsOnTable: 7 };
    s = placeCoin(s, -8.7, 1); // B layer 1 at 150.05
    expect(s.status).toBe('active');
    s = placeCoin(s, -28.5, 1); // B layer 2 at 121.55, edge gap to 58.1 is 0 or less -> touch
    expect(s.status).toBe('touched');
    expect(s.score).toBe(6);
  });
  it('coins only touch the same layer of the neighbour', () => {
    const s0 = createRound('twin', 't3', PERFECT);
    // A has a leaning coin at layer 3, B only reaches layer 2: no touch
    const a: Coin[] = [coin(0), coin(0), coin(0), coin(60)];
    let s: RoundState = { ...s0, stacks: [a, s0.stacks[1]!] };
    s = placeCoin(s, -8.7, 1);
    s = placeCoin(s, -28.5, 1);
    expect(s.touching).toEqual([false]);
    expect(s.status).toBe('active');
  });
  it('a fall in twin mode scores 0 and charges the fee on all coins on the table', () => {
    let s = build('twin', [10, 10, 10, 10], 0);
    s = placeCoin(s, 40, 1);
    expect(s.status).toBe('fell');
    expect(s.score).toBe(0);
    expect(s.coinsOnTable).toBe(2 + 4 + 1);
    expect(s.fallFee).toBe(1);
    expect(s.fall?.stack).toBe(1);
  });
  it('the other stack is not affected by a move on one stack', () => {
    const s = createRound('twin', 't4', PERFECT);
    const t = placeCoin(s, 5, 0);
    expect(t.stacks[1]).toEqual(s.stacks[1]);
  });
});

describe('2D placement and geometry', () => {
  it('accepts a bare number (along +x) or { dx, dy }, and stores dx, dy in the move list', () => {
    const s = placeCoin(createRound('single', 1, PERFECT), { dx: 12.34, dy: -5.55 });
    expect(s.moves[0]).toEqual({ type: 'place', stack: 0, dx: 12.3, dy: -5.5 });
    expect(placeCoin(createRound('single', 1, PERFECT), 7).moves[0]).toEqual({ type: 'place', stack: 0, dx: 7, dy: 0 });
  });
  it('stability uses straight line distance: a diagonal lean stands inside the circle and falls outside', () => {
    expect(placeCoin(createRound('single', 1, PERFECT), { dx: 22, dy: 22 }).status).toBe('active'); // 31.11
    expect(placeCoin(createRound('single', 1, PERFECT), { dx: 23, dy: 23 }).status).toBe('fell'); // 32.53
  });
  it('single stack score is the straight line reach, rounded down', () => {
    expect(build('single', [{ dx: 20, dy: 20 }]).score).toBe(28);
    expect(overhangScoreMm([coin(0, 0), coin(30, 40)])).toBe(50);
  });
  it('polar and aim helpers just produce dx, dy', () => {
    const p = offsetFromPolar(10, 90);
    expect(p.dx).toBeCloseTo(0, 9);
    expect(p.dy).toBeCloseTo(10, 9);
    const t = offsetToward(0, 0, 3, 4, 10);
    expect(t.dx).toBeCloseTo(6, 9);
    expect(t.dy).toBeCloseTo(8, 9);
    expect(offsetToward(1, 1, 1, 1, 10)).toEqual({ dx: 0, dy: 0 });
  });
  it('table is a disc around the centroid of the first coins, 200 mm past the furthest one', () => {
    expect(createRound('single', 1, 0).tableRadiusMm).toBe(200);
    expect(createRound('twin', 1, 0).tableRadiusMm).toBeCloseTo(79.38 + 200, 1);
    expect(createRound('triple', 1, 0).tableRadiusMm).toBeCloseTo(158.75 / Math.sqrt(3) + 200, 1);
  });
});

describe('mode 3: three stacks in an equilateral triangle', () => {
  it('puts every pair of first coins the same distance apart as twin mode (95.25 mm edge gap)', () => {
    const s = createRound('triple', 1, PERFECT);
    const c = s.stacks.map((st) => st[0]!);
    for (const [i, j] of [[0, 1], [1, 2], [0, 2]] as const) {
      const d = Math.hypot(c[i]!.x - c[j]!.x, c[i]!.y - c[j]!.y);
      expect(d).toBeCloseTo(158.75, 1);
      expect(d - COIN_DIAMETER_MM).toBeCloseTo(95.25, 1);
    }
    expect(s.pairs).toEqual([[0, 1], [1, 2], [0, 2]]);
    expect(s.touching).toEqual([false, false, false]);
  });
  it('allConnected: a chain of touches is enough, one touch is not', () => {
    const pairs: [number, number][] = [[0, 1], [1, 2], [0, 2]];
    expect(allConnected(3, pairs, [false, false, false])).toBe(false);
    expect(allConnected(3, pairs, [true, false, false])).toBe(false);
    expect(allConnected(3, pairs, [true, true, false])).toBe(true); // A-B and B-C
    expect(allConnected(3, pairs, [true, false, true])).toBe(true); // A-B and A-C
    expect(allConnected(3, pairs, [false, true, true])).toBe(true); // B-C and A-C
    expect(allConnected(3, pairs, [true, true, true])).toBe(true);
    expect(allConnected(2, [[0, 1]], [true])).toBe(true);
    expect(allConnected(1, [], [])).toBe(false);
  });
  it('one touching pair is not enough: the round carries on and cash out scores 0', () => {
    const s0 = createRound('triple', 'tr', PERFECT);
    const a: Coin[] = [s0.stacks[0]![0]!, coin(100, 0)];
    let s: RoundState = { ...s0, stacks: [a, s0.stacks[1]!, s0.stacks[2]!] };
    s = placeCoin(s, 0, 1); // B layer 1 at (158.75, 0): 58.75 from A1 -> A-B touch
    expect(s.touching).toEqual([true, false, false]);
    expect(s.status).toBe('active');
    expect(s.score).toBe(0);
    expect(cashOut(s).score).toBe(0);
  });
  it('a chain A-B and B-C connects all three: round ends, score = tallest stack', () => {
    const s0 = createRound('triple', 'tr2', PERFECT);
    const a: Coin[] = [s0.stacks[0]![0]!, coin(100, 0)];
    const c: Coin[] = [s0.stacks[2]![0]!, coin(130, 50), coin(130, 50)];
    let s: RoundState = { ...s0, stacks: [a, s0.stacks[1]!, c], coinsOnTable: 6 };
    s = placeCoin(s, 0, 1); // B1 at (158.75, 0): touches A1 (58.75) and C1 (57.7)
    expect(s.touching).toEqual([true, true, false]);
    expect(s.status).toBe('touched');
    expect(s.score).toBe(3); // C has 3 coins, the tallest
  });
  it('touches are remembered across moves and only same layers count', () => {
    const s0 = createRound('triple', 'tr3', PERFECT);
    const c: Coin[] = [s0.stacks[2]![0]!, coin(130, 50)];
    const a: Coin[] = [s0.stacks[0]![0]!, coin(0, 0), coin(100, 0)];
    let s: RoundState = { ...s0, stacks: [a, s0.stacks[1]!, c], coinsOnTable: 6 };
    s = placeCoin(s, 0, 1); // layer 1: B touches C1; A1 is at the origin, too far
    expect(s.touching).toEqual([false, true, false]);
    expect(s.status).toBe('active');
    s = placeCoin(s, 0, 1); // layer 2: B2 touches A2 at (100, 0)
    expect(s.touching).toEqual([true, true, false]);
    expect(s.status).toBe('touched');
    expect(s.score).toBe(3);
  });
  it('a fall in triple mode scores 0 and the fee counts every coin on the table', () => {
    const s = placeCoin(createRound('triple', 'tf', PERFECT), { dx: 0, dy: 45 }, 2);
    expect(s.status).toBe('fell');
    expect(s.score).toBe(0);
    expect(s.coinsOnTable).toBe(4);
    expect(s.fallFee).toBe(1);
  });
  it('aiming every stack at the centre of the triangle connects them with a short lean', () => {
    // all three lean 4 coin harmonic toward the centroid, layer by layer
    let s = createRound('triple', 'aim', PERFECT);
    const cx = s.tableCenter.x;
    const cy = s.tableCenter.y;
    const steps = [10.5, 15.8, 31.7];
    let layer = 0;
    while (s.status === 'active' && layer < steps.length) {
      for (let st = 0; st < 3 && s.status === 'active'; st++) {
        const top = s.stacks[st]![s.stacks[st]!.length - 1]!;
        s = placeCoin(s, offsetToward(top.x, top.y, cx, cy, steps[layer]!), st);
      }
      layer++;
    }
    expect(s.status).toBe('touched');
    expect(s.score).toBe(4);
  });
});

describe('twin and triple score cap (second tallest + 10)', () => {
  const stacks = (...counts: number[]) => counts.map((n) => Array.from({ length: n }, () => coin(0)));
  it('twin: tallest is capped at the other stack + 10', () => {
    expect(teamScore(stacks(40, 5))).toEqual({ raw: 40, capped: 15 });
    expect(teamScore(stacks(5, 40))).toEqual({ raw: 40, capped: 15 });
    expect(teamScore(stacks(14, 5))).toEqual({ raw: 14, capped: 14 });
    expect(teamScore(stacks(15, 5))).toEqual({ raw: 15, capped: 15 });
    expect(teamScore(stacks(16, 5))).toEqual({ raw: 16, capped: 15 });
  });
  it('triple: uses the second tallest of the three', () => {
    expect(teamScore(stacks(30, 12, 3))).toEqual({ raw: 30, capped: 22 });
    expect(teamScore(stacks(3, 30, 12))).toEqual({ raw: 30, capped: 22 });
    expect(teamScore(stacks(20, 18, 17))).toEqual({ raw: 20, capped: 20 });
    expect(teamScore(stacks(9, 9, 9))).toEqual({ raw: 9, capped: 9 });
  });
  it('a real touch stores both rawScore and the capped score', () => {
    const s0 = createRound('twin', 'capr', PERFECT);
    const tall: Coin[] = [coin(0), coin(0), coin(58.1), ...Array.from({ length: 27 }, () => coin(0))];
    let s: RoundState = { ...s0, stacks: [tall, s0.stacks[1]!], coinsOnTable: 31 };
    s = placeCoin(s, -8.7, 1);
    s = placeCoin(s, -28.5, 1);
    expect(s.status).toBe('touched');
    expect([s.rawScore, s.score]).toEqual([30, 13]);
    expect(toRecord(s)).toMatchObject({ rawScore: 30, score: 13 });
  });
  it('single stack and falls have rawScore equal to score', () => {
    const c = cashOut(build('single', [10.5, 15.8, 31.7]));
    expect([c.rawScore, c.score]).toEqual([58, 58]);
    const f = placeCoin(createRound('single', 1, PERFECT), 50);
    expect([f.rawScore, f.score]).toEqual([0, 0]);
  });
});

describe('fall fee', () => {
  it('is ceil(5 percent) in whole tokens', () => {
    expect(fallFee(0)).toBe(0);
    expect(fallFee(1)).toBe(1);
    expect(fallFee(20)).toBe(1);
    expect(fallFee(21)).toBe(2);
    expect(fallFee(100)).toBe(5);
    expect(fallFee(101)).toBe(6);
    expect(fallFee(1000)).toBe(50);
    expect(fallFee(1001)).toBe(51);
  });
  it('matches ceil(0.05 x n) over a range', () => {
    for (let n = 0; n <= 2000; n++) expect(fallFee(n)).toBe(Math.ceil(n / 20));
  });
  it('rejects fractions and negatives', () => {
    expect(() => fallFee(1.5)).toThrow();
    expect(() => fallFee(-1)).toThrow();
  });
  it('is recorded on the state at the fall and is 0 otherwise', () => {
    const fell = placeCoin(createRound('single', 1, PERFECT), 50);
    expect(fell.fallFee).toBe(1); // 2 coins on the table
    expect(cashOut(createRound('single', 1, PERFECT)).fallFee).toBe(0);
  });
});

describe('house bots', () => {
  it('has 10 archetypes with unique ids', () => {
    expect(ARCHETYPES.length).toBe(10);
    expect(new Set(ARCHETYPES.map((a) => a.id)).size).toBe(10);
  });
  it('every archetype finishes a round in every mode', () => {
    for (const mode of ['single', 'twin', 'triple'] as Mode[]) {
      for (const a of ARCHETYPES) {
        const { state } = playHouseRound({ mode, seed: `fin-${a.id}`, volumeUsd: 10_000, archetype: a });
        expect(state.status).not.toBe('active');
        expect(state.score).toBeGreaterThanOrEqual(0);
      }
    }
  });
  it('a harmonic bot reaches a good score on perfect coins', () => {
    const { state } = playHouseRound({ mode: 'single', seed: 'h', volumeUsd: PERFECT, archetype: 'harmonic-long' });
    expect(state.status).toBe('cashed');
    expect(state.score).toBeGreaterThan(60);
  });
  it('bots can connect three stacks on perfect coins', () => {
    let touched = 0;
    for (let i = 0; i < 20; i++) {
      const { state } = playHouseRound({ mode: 'triple', seed: `tp${i}`, volumeUsd: PERFECT, archetype: 'quality-reader' });
      if (state.status === 'touched') touched++;
    }
    expect(touched).toBeGreaterThan(0);
  });
});

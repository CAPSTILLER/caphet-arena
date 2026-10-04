import { createPublicClient, createWalletClient, getAddress, http, keccak256, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia, foundry } from 'viem/chains';
import type { LedgerEntry } from '../ledger.js';
import type { Mode, Move } from '../types.js';
import { gameRecordsAbi } from './abi.js';

/**
 * Optional onchain record of every finished round (contracts/src/GameRecords.sol).
 * Off by default. The server holds an OPERATOR key that can only write records: no tokens, no payouts.
 */

export const MODE_INDEX: Record<Mode, number> = { single: 0, twin: 1, triple: 2 };
/** 0 = fell, 1 = cashed out, 2 = stacks connected (twin/triple win). */
export type ChainOutcome = 0 | 1 | 2;

export interface ChainRecord {
  /** keccak256 of the round id text, e.g. keccak256("r_57c9d015fb2f") */
  roundId: Hex;
  wallet: Hex;
  mode: number;
  outcome: ChainOutcome;
  /** The score registered for the wallet (full, uncapped). 0 when the round registers none. */
  score: number;
  /** round(quality * 10), 0 to 10 */
  volumeBucket: number;
  /** sha256("<roundId>:<seed>") */
  seedCommit: Hex;
  movesHash: Hex;
}

/** Canonical move list text: place = "p:<stack>:<dx>:<dy>", cashout = "c", joined by ";". Numbers as JavaScript prints them. */
export function movesString(moves: Move[]): string {
  return moves.map((m) => (m.type === 'place' ? `p:${m.stack}:${m.dx}:${m.dy}` : 'c')).join(';');
}
export const movesHash = (moves: Move[]): Hex => keccak256(toHex(movesString(moves)));
export const roundIdHash = (roundId: string): Hex => keccak256(toHex(roundId));
export const volumeBucketOf = (quality: number): number => Math.max(0, Math.min(10, Math.round(quality * 10)));

export function outcomeOf(l: LedgerEntry): ChainOutcome {
  if (l.outcome === 'fell') return 0;
  if (l.outcome === 'touched') return 2;
  return 1;
}

export function buildChainRecord(r: { id: string; wallet: string; mode: Mode; quality: number; seedCommit: string; moves: Move[]; ledger: LedgerEntry }): ChainRecord {
  return {
    roundId: roundIdHash(r.id),
    wallet: getAddress(r.wallet),
    mode: MODE_INDEX[r.mode],
    outcome: outcomeOf(r.ledger),
    score: r.ledger.recordedScore ?? 0,
    volumeBucket: volumeBucketOf(r.quality),
    seedCommit: `0x${r.seedCommit}`,
    movesHash: movesHash(r.moves),
  };
}

export interface RoundRecorder {
  readonly kind: string;
  /** Writes one record. Must be safe to call again for the same round (returns the existing state instead of failing). */
  record(rec: ChainRecord): Promise<{ txHash: string }>;
  info(): Record<string, unknown>;
}

/** For tests and local dev: keeps records in memory, can be told to fail. */
export class MockRecorder implements RoundRecorder {
  readonly kind = 'mock';
  records = new Map<string, ChainRecord>();
  failNext = 0;
  calls = 0;
  async record(rec: ChainRecord): Promise<{ txHash: string }> {
    this.calls++;
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('mock chain failure');
    }
    if (this.records.has(rec.roundId)) return { txHash: 'already-recorded' };
    this.records.set(rec.roundId, rec);
    return { txHash: `0xmock${this.records.size.toString(16).padStart(60, '0')}` };
  }
  info() {
    return { kind: 'mock', recorded: this.records.size };
  }
}

export interface ViemRecorderOptions {
  /** 31337 is for a local anvil node only (scripts/chain-local-check.ts). */
  chainId: 8453 | 84532 | 31337;
  rpcUrl: string;
  contract: string;
  operatorKey: string;
}

/** Real recorder: signs with the operator key, sends recordRound and waits until it is mined. Sends are serialized so nonces do not clash. */
export class ViemRecorder implements RoundRecorder {
  readonly kind = 'viem';
  private queue: Promise<unknown> = Promise.resolve();
  private account;
  private pub;
  private wallet;
  private contract: Hex;
  constructor(private o: ViemRecorderOptions) {
    const chain = o.chainId === 8453 ? base : o.chainId === 31337 ? foundry : baseSepolia;
    this.account = privateKeyToAccount(o.operatorKey as Hex);
    this.contract = getAddress(o.contract);
    this.pub = createPublicClient({ chain, transport: http(o.rpcUrl) });
    this.wallet = createWalletClient({ chain, account: this.account, transport: http(o.rpcUrl) });
  }
  record(rec: ChainRecord): Promise<{ txHash: string }> {
    const run = async () => {
      const done = await this.pub.readContract({ address: this.contract, abi: gameRecordsAbi, functionName: 'isRecorded', args: [rec.roundId] });
      if (done) return { txHash: 'already-recorded' };
      const txHash = await this.wallet.writeContract({
        address: this.contract,
        abi: gameRecordsAbi,
        functionName: 'recordRound',
        args: [rec.roundId, rec.wallet, rec.mode, rec.outcome, rec.score, rec.volumeBucket, rec.seedCommit, rec.movesHash],
      });
      const receipt = await this.pub.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
      if (receipt.status !== 'success') throw new Error(`recordRound reverted in ${txHash}`);
      return { txHash };
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
  info() {
    return { kind: 'viem', chainId: this.o.chainId, contract: this.contract, operator: this.account.address };
  }
}

/**
 * Environment (all needed to switch it on):
 *   CHAIN_RECORDS=on  CHAIN_ID=84532|8453  CHAIN_RPC_URL  GAME_RECORDS_ADDRESS  OPERATOR_PRIVATE_KEY
 * Anything missing or CHAIN_RECORDS not "on" means disabled (returns null). CHAIN_RECORDS=mock gives the in-memory mock.
 */
export function recorderFromEnv(env: NodeJS.ProcessEnv = process.env): RoundRecorder | null {
  if (env.CHAIN_RECORDS === 'mock') return new MockRecorder();
  if (env.CHAIN_RECORDS !== 'on') return null;
  const chainId = Number(env.CHAIN_ID);
  const missing = ['CHAIN_ID', 'CHAIN_RPC_URL', 'GAME_RECORDS_ADDRESS', 'OPERATOR_PRIVATE_KEY'].filter((k) => !env[k]);
  if (missing.length) throw new Error(`CHAIN_RECORDS=on needs ${missing.join(', ')}`);
  if (chainId !== 8453 && chainId !== 84532) throw new Error('CHAIN_ID must be 84532 (Base Sepolia) or 8453 (Base)');
  return new ViemRecorder({ chainId, rpcUrl: env.CHAIN_RPC_URL!, contract: env.GAME_RECORDS_ADDRESS!, operatorKey: env.OPERATOR_PRIVATE_KEY! });
}

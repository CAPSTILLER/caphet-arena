/**
 * Local proof that the server's recorder and the contract agree. Needs Foundry (anvil, forge) on PATH.
 *   npx tsx scripts/chain-local-check.ts
 * Starts anvil, deploys GameRecords with forge, plays rounds through the real app with the real ViemRecorder,
 * and reads the results back from the contract. Nothing leaves this machine.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createPublicClient, http, keccak256, toHex } from 'viem';
import { foundry } from 'viem/chains';
import { gameRecordsAbi } from '../src/chain/abi.js';
import { ViemRecorder } from '../src/chain/records.js';
import { createApp } from '../src/server/app.js';
import { FixedVolumeProvider } from '../src/server/volume.js';

// anvil's well known test accounts (public, worthless)
const DEPLOYER = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const OWNER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const OPERATOR_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const OPERATOR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const RPC = 'http://127.0.0.1:8546';

const anvil = spawn('anvil', ['--port', '8546', '--silent']);
try {
  await new Promise((r) => setTimeout(r, 1500));
  const out = execFileSync('forge', ['script', 'script/Deploy.s.sol', '--rpc-url', RPC, '--broadcast', '--private-key', DEPLOYER], {
    cwd: new URL('../contracts', import.meta.url).pathname,
    env: { ...process.env, OWNER_ADDRESS: OWNER, OPERATOR_ADDRESS: OPERATOR },
  }).toString();
  const contract = /g: contract GameRecords (0x[0-9a-fA-F]{40})/.exec(out)?.[1];
  if (!contract) throw new Error('deploy failed:\n' + out);
  console.log('deployed GameRecords at', contract);

  const recorder = new ViemRecorder({ chainId: 31337, rpcUrl: RPC, contract, operatorKey: OPERATOR_KEY });

  const { app } = createApp({ volume: new FixedVolumeProvider(100_000), recorder, config: { chainWaitMs: 15_000, houseSecret: '', serverSecret: 'local' } });
  const post = async (path: string, body: unknown, key?: string) =>
    (await app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) })).json() as Promise<any>;

  const wallet = '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc';
  const results: string[] = [];
  for (const dx of [20.4, 60]) {
    const j = await post('/join', { wallet, mode: 'single', botName: 'Local' });
    const p = await post('/place', { dx, dy: 0, stack: 0 }, j.key);
    const end = p.status === 'active' ? await post('/cashout', {}, j.key) : p;
    const rep = (await (await app.request(`/replay/${j.roundId}`)).json()) as any;
    results.push(`${j.roundId} ${end.status} chain=${rep.chain.status} tx=${String(rep.chain.txHash).slice(0, 12)} ${rep.chain.error ?? ''}`);
    const pub = createPublicClient({ chain: foundry, transport: http(RPC) });
    const rec = (await pub.readContract({ address: contract as `0x${string}`, abi: [...gameRecordsAbi, { type: 'function', name: 'getRound', stateMutability: 'view', inputs: [{ name: 'roundId', type: 'bytes32' }], outputs: [{ type: 'tuple', components: [
      { name: 'roundId', type: 'bytes32' }, { name: 'wallet', type: 'address' }, { name: 'mode', type: 'uint8' }, { name: 'outcome', type: 'uint8' }, { name: 'score', type: 'uint32' }, { name: 'volumeBucket', type: 'uint16' }, { name: 'recordedAt', type: 'uint64' }, { name: 'seedCommit', type: 'bytes32' }, { name: 'movesHash', type: 'bytes32' }] }] }], functionName: 'getRound', args: [keccak256(toHex(j.roundId))] })) as any;
    console.log('isRecorded', await pub.readContract({ address: contract as `0x${string}`, abi: gameRecordsAbi, functionName: 'isRecorded', args: [keccak256(toHex(j.roundId))] }), 'block', await pub.getBlockNumber());
    console.log(`onchain ${j.roundId}: wallet=${rec.wallet} mode=${rec.mode} outcome=${rec.outcome} score=${rec.score} bucket=${rec.volumeBucket} seedCommit=${rec.seedCommit === `0x${rep.seedCommit}`}`);
  }
  console.log(results.join('\n'));
  const pub = createPublicClient({ chain: foundry, transport: http(RPC) });
  console.log('bestScore onchain:', await pub.readContract({ address: contract as `0x${string}`, abi: gameRecordsAbi, functionName: 'bestScore', args: [wallet, 0] }));
} finally {
  anvil.kill();
}

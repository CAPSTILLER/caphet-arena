/** Read-only CAPH token check on Base. Usage: npx tsx scripts/caph-check.ts */
import { CAPH_ADDRESS, getCaphMarket } from '../src/market/volume.js';

const RPCS = ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'];

async function call(data: string): Promise<string> {
  let last = '';
  for (const url of RPCS) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: CAPH_ADDRESS, data }, 'latest'] }),
    });
    const j = (await res.json()) as { result?: string; error?: { message: string } };
    if (j.result) return j.result;
    last = j.error?.message ?? 'no result';
  }
  throw new Error(last);
}
const str = (hex: string): string => {
  const len = parseInt(hex.slice(2 + 64, 2 + 128), 16);
  return Buffer.from(hex.slice(2 + 128, 2 + 128 + len * 2), 'hex').toString('utf8');
};

const name = str(await call('0x06fdde03'));
const symbol = str(await call('0x95d89b41'));
const decimals = parseInt(await call('0x313ce567'), 16);
const supplyRaw = BigInt(await call('0x18160ddd'));
console.log({ name, symbol, decimals, totalSupplyRaw: supplyRaw.toString(), totalSupply: (supplyRaw / 10n ** BigInt(decimals)).toString() });
try {
  console.log(await getCaphMarket());
} catch (e) {
  console.log('market lookup failed (rate limit or not indexed):', e instanceof Error ? e.message : e);
}

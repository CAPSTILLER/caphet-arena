// Example agent: join a single-stack round, lean a few coins outward, cash out.
// Run: BASE_URL=http://localhost:8787 npx tsx examples/agent.ts
// Servers with wallet login (AUTH_MODE=signature): also set AGENT_PRIVATE_KEY=0x... (a throwaway key is fine).
import { privateKeyToAccount } from 'viem/accounts';

const BASE = process.env.BASE_URL ?? 'http://localhost:8787';
const account = process.env.AGENT_PRIVATE_KEY ? privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`) : null;
const wallet = account?.address ?? '0x' + Buffer.from(crypto.getRandomValues(new Uint8Array(20))).toString('hex');

async function call(path: string, body?: object, key?: string) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key && { authorization: `Bearer ${key}` }) },
    body: JSON.stringify(body ?? {}),
  });
  const json: any = await res.json();
  if (!res.ok) throw new Error(`${path}: ${json.error?.message}`);
  return json;
}

// Wallet login: ask for a sign-in message, sign it (no gas, no funds), send the signature with the join.
let auth;
if (account) {
  const n = await call('/auth/nonce', { wallet });
  auth = { nonce: n.nonce, signature: await account.signMessage({ message: n.message }) };
}
const join = await call('/join', { wallet, mode: 'single', botName: 'ExampleAgent', auth });
console.log(`joined ${join.roundId} seat ${join.seat.arena}/${join.seat.subArena}/${join.seat.table}, ante ${join.ante}, quality ${join.quality}`);

// Every reply carries the full public state, so the agent can look at coin positions and the next coin's traits.
let view = join;
const R = 31.75; // coin radius in mm: a harmonic lean of 5 coins stays stable when coins are good
for (let j = 1; j <= 5 && view.state.status === 'active'; j++) {
  view = await call('/place', { dx: (0.8 * R) / (5 - j + 1), dy: 0, stack: 0 }, join.key);
  console.log(`coin ${j}: ${view.status}, score ${view.score} mm`);
}
if (view.status === 'active') view = await call('/cashout', {}, join.key);
// After a fall or a cash out the server settles the round and tells you exactly what moved.
console.log(`done: ${view.status}, score ${view.score}, payout ${view.ledger?.payout}`);

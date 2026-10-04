/**
 * Local dev server. Usage: npx tsx scripts/serve.ts
 * Env: PORT (default 8787), DATA_DIR (keep data on disk), HOUSE_SECRET (enable house bots),
 *      SERVER_SECRET, VOLUME_OVERRIDE_USD (pin the CAPH volume instead of calling the market APIs).
 */
import { appFromEnv } from '../src/server/env.js';
import { startServer } from '../src/server/node.js';

const port = Number(process.env.PORT ?? 8787);
const { app, storeKind } = await appFromEnv();
const srv = await startServer(app, port);
console.log(`stackgame server on ${srv.url} (store: ${storeKind})`);
console.log(`rules:  ${srv.url}/llms.txt   spec: ${srv.url}/openapi.json`);

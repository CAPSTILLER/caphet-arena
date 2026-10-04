/**
 * Vercel Function entry (Node runtime). vercel.json rewrites every path here.
 * Set BLOB_READ_WRITE_TOKEN (Vercel Blob store), SERVER_SECRET and HOUSE_SECRET in the project env.
 * NOT deployed or tested on Vercel yet; locally it is exercised through scripts/serve.ts and the tests.
 */
import { handle } from 'hono/vercel';
import { appFromEnv } from '../src/server/env.js';

export const config = { runtime: 'nodejs' };

let handler: ((req: Request) => Response | Promise<Response>) | undefined;

export default async function (req: Request): Promise<Response> {
  if (!handler) handler = handle((await appFromEnv()).app) as (req: Request) => Promise<Response>;
  return handler(req);
}

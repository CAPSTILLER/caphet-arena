/**
 * Vercel Function entry (Node.js runtime, Web Standard "fetch" export). vercel.json sends every path here.
 * It needs no environment variables to run the watch-only demo. Optional settings are listed in DEPLOY.md.
 * Locally the same app runs through scripts/serve.ts, and the tests call this file's fetch directly.
 */
import { handle } from 'hono/vercel';
import { appFromEnv } from '../src/server/env.js';

let handler: ((req: Request) => Response | Promise<Response>) | undefined;

export default {
  async fetch(req: Request): Promise<Response> {
    if (!handler) handler = handle((await appFromEnv()).app) as (req: Request) => Promise<Response>;
    return handler(req);
  },
};

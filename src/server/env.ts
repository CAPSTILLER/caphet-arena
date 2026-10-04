import { recorderFromEnv } from '../chain/records.js';
import { createApp, type AppDeps } from './app.js';
import { BlobStore, realBlobClient } from './store/blob.js';
import { FileStore } from './store/file.js';
import { MemoryStore } from './store/memory.js';
import type { Store } from './store/types.js';

/**
 * Pick the store from the environment:
 *   BLOB_READ_WRITE_TOKEN (or BLOB_STORE_ID on Vercel) -> Vercel Blob (production)
 *   DATA_DIR                                           -> JSON files on disk (local dev, survives restarts)
 *   otherwise                                          -> memory (tests, throwaway dev)
 */
export async function storeFromEnv(): Promise<{ store: Store; kind: 'blob' | 'file' | 'memory' }> {
  if (process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID) {
    return { store: new BlobStore(await realBlobClient(), process.env.BLOB_ROOT ?? 'stackgame/'), kind: 'blob' };
  }
  if (process.env.DATA_DIR) return { store: new FileStore(process.env.DATA_DIR), kind: 'file' };
  return { store: new MemoryStore(), kind: 'memory' };
}

export async function appFromEnv(extra: AppDeps = {}) {
  const { store, kind } = await storeFromEnv();
  const recorder = extra.recorder !== undefined ? extra.recorder : recorderFromEnv();
  const made = createApp({ store, recorder, ...extra });
  // Records go onchain under wallet addresses, so wallets must be proven first.
  if (recorder && recorder.kind !== 'mock' && made.config.authMode !== 'signature') {
    throw new Error('Onchain records need AUTH_MODE=signature (wallets must be verified before results are written to a chain).');
  }
  return { ...made, storeKind: kind };
}

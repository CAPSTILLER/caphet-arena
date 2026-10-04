import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BlobStore, type BlobClient } from '../src/server/store/blob.js';
import { FileStore } from '../src/server/store/file.js';
import { MemoryStore } from '../src/server/store/memory.js';
import type { Store } from '../src/server/store/types.js';

async function contract(store: Store): Promise<void> {
  expect(await store.get('a/1')).toBeNull();
  await store.put('a/1', { n: 1 });
  expect(await store.get('a/1')).toEqual({ n: 1 });
  await store.put('a/1', { n: 2 });
  expect(await store.get('a/1')).toEqual({ n: 2 });
  expect(await store.putIfAbsent('a/1', { n: 9 })).toBe(false);
  expect(await store.get('a/1')).toEqual({ n: 2 });
  expect(await store.putIfAbsent('a/2', { n: 3 })).toBe(true);
  expect(await store.putIfAbsent('a/2', { n: 4 })).toBe(false);
  await store.put('b/1', { n: 5 });
  expect((await store.list('a/')).sort()).toEqual(['a/1', 'a/2']);
  expect(await store.list('b/')).toEqual(['b/1']);
  await store.delete('a/1');
  expect(await store.get('a/1')).toBeNull();
  expect(await store.list('a/')).toEqual(['a/2']);
  const wins = await Promise.all(Array.from({ length: 10 }, (_, i) => store.putIfAbsent('seat/1', { i })));
  expect(wins.filter(Boolean)).toHaveLength(1);
}

/** A fake of the Vercel Blob SDK slice, keeping blobs in a Map, to test the adapter without credentials. */
function fakeBlob(): BlobClient & { calls: string[] } {
  const blobs = new Map<string, string>();
  const calls: string[] = [];
  return {
    calls,
    async put(pathname, body, opts) {
      calls.push(`put ${pathname} private=${opts.access === 'private'} overwrite=${opts.allowOverwrite}`);
      if (!opts.allowOverwrite && blobs.has(pathname)) throw new Error('This blob already exists, use `allowOverwrite: true` to overwrite it');
      blobs.set(pathname, body);
      return {};
    },
    async get(pathname) {
      const v = blobs.get(pathname);
      if (v === undefined) return null;
      return { statusCode: 200, stream: new Response(v).body };
    },
    async del(pathname) {
      for (const p of Array.isArray(pathname) ? pathname : [pathname]) blobs.delete(p);
    },
    async list({ prefix }) {
      return { blobs: [...blobs.keys()].filter((k) => k.startsWith(prefix)).map((pathname) => ({ pathname })), hasMore: false };
    },
  };
}

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('store adapters share one contract', () => {
  it('MemoryStore', async () => contract(new MemoryStore()));
  it('FileStore (temp dir)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'stackgame-'));
    dirs.push(dir);
    await contract(new FileStore(dir));
  });
  it('BlobStore with a fake client, private access and no credentials', async () => {
    const client = fakeBlob();
    await contract(new BlobStore(client, 'sg/'));
    expect(client.calls.every((c) => c.includes('private=true'))).toBe(true);
    expect(client.calls[0]).toContain('sg/a/1.json');
  });
  it('FileStore keeps data across instances', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'stackgame-'));
    dirs.push(dir);
    await new FileStore(dir).put('x/y', { ok: true });
    expect(await new FileStore(dir).get('x/y')).toEqual({ ok: true });
  });
});

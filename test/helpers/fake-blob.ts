import type { BlobClient } from '../../src/server/store/blob.js';

/** A fake of the Vercel Blob SDK slice, keeping blobs in a Map, to test the adapter without credentials. */
export function fakeBlob(): BlobClient & { calls: string[] } {
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


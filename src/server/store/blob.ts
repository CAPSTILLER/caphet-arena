import type { Store } from './types.js';

/**
 * The slice of the @vercel/blob SDK this adapter uses. Passing the client in keeps the adapter
 * testable without credentials (tests pass a fake) and keeps the SDK out of the tests' import graph.
 */
export interface BlobClient {
  put(
    pathname: string,
    body: string,
    opts: { access: 'private'; allowOverwrite: boolean; addRandomSuffix: false; contentType: string; cacheControlMaxAge?: number },
  ): Promise<unknown>;
  get(pathname: string, opts: { access: 'private'; useCache: false }): Promise<{ statusCode: number; stream: ReadableStream<Uint8Array> | null } | null>;
  del(pathname: string | string[]): Promise<void>;
  list(opts: { prefix: string; cursor?: string; limit?: number }): Promise<{ blobs: { pathname: string }[]; cursor?: string; hasMore: boolean }>;
}

/** Production adapter: Vercel Blob, private access, one JSON blob per key. */
export class BlobStore implements Store {
  constructor(
    private client: BlobClient,
    private root = 'stackgame/',
  ) {}

  private p(key: string): string {
    return `${this.root}${key}.json`;
  }

  async get<T>(key: string): Promise<T | null> {
    const r = await this.client.get(this.p(key), { access: 'private', useCache: false });
    if (!r || r.statusCode !== 200 || !r.stream) return null;
    return JSON.parse(await new Response(r.stream).text()) as T;
  }
  async put(key: string, value: unknown): Promise<void> {
    await this.client.put(this.p(key), JSON.stringify(value), {
      access: 'private',
      allowOverwrite: true,
      addRandomSuffix: false,
      contentType: 'application/json',
      cacheControlMaxAge: 60,
    });
  }
  async putIfAbsent(key: string, value: unknown): Promise<boolean> {
    try {
      await this.client.put(this.p(key), JSON.stringify(value), {
        access: 'private',
        allowOverwrite: false,
        addRandomSuffix: false,
        contentType: 'application/json',
        cacheControlMaxAge: 60,
      });
      return true;
    } catch (e) {
      if (e instanceof Error && /already exists|exists/i.test(e.message)) return false;
      throw e;
    }
  }
  async delete(key: string): Promise<void> {
    await this.client.del(this.p(key));
  }
  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.client.list({ prefix: this.p(prefix).replace(/\.json$/, ''), cursor, limit: 1000 });
      for (const b of r.blobs) out.push(b.pathname.slice(this.root.length, -'.json'.length));
      cursor = r.hasMore ? r.cursor : undefined;
    } while (cursor);
    return out.sort();
  }
}

/** Build a BlobClient from the real SDK. Only called in production, so tests never import it. */
export async function realBlobClient(): Promise<BlobClient> {
  const sdk = await import('@vercel/blob');
  return {
    put: (pathname, body, opts) => sdk.put(pathname, body, opts),
    get: (pathname, opts) => sdk.get(pathname, opts) as never,
    del: (pathname) => sdk.del(pathname),
    list: (opts) => sdk.list(opts) as never,
  };
}

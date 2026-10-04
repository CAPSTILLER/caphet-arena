import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Store } from './types.js';

/** One JSON file per key under a directory. For local dev that survives restarts. Node only. */
export class FileStore implements Store {
  constructor(private dir: string) {}

  private file(key: string): string {
    return path.join(this.dir, `${encodeURIComponent(key)}.json`);
  }
  private async ensure(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      return JSON.parse(await fs.readFile(this.file(key), 'utf8')) as T;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }
  async put(key: string, value: unknown): Promise<void> {
    await this.ensure();
    const tmp = `${this.file(key)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(value));
    await fs.rename(tmp, this.file(key));
  }
  async putIfAbsent(key: string, value: unknown): Promise<boolean> {
    await this.ensure();
    try {
      await fs.writeFile(this.file(key), JSON.stringify(value), { flag: 'wx' });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw e;
    }
  }
  async delete(key: string): Promise<void> {
    await fs.rm(this.file(key), { force: true });
  }
  async list(prefix: string): Promise<string[]> {
    await this.ensure();
    const names = await fs.readdir(this.dir);
    return names
      .filter((n) => n.endsWith('.json'))
      .map((n) => decodeURIComponent(n.slice(0, -5)))
      .filter((k) => k.startsWith(prefix))
      .sort();
  }
}

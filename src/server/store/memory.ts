import type { Store } from './types.js';

/** In-memory store for tests and local dev. Values are copied through JSON so nothing is shared by reference. */
export class MemoryStore implements Store {
  private data = new Map<string, string>();

  async get<T>(key: string): Promise<T | null> {
    const v = this.data.get(key);
    return v === undefined ? null : (JSON.parse(v) as T);
  }
  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, JSON.stringify(value));
  }
  async putIfAbsent(key: string, value: unknown): Promise<boolean> {
    if (this.data.has(key)) return false;
    this.data.set(key, JSON.stringify(value));
    return true;
  }
  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}

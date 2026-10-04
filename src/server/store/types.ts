/**
 * Storage behind a tiny interface so the game logic never knows where data lives.
 * Values are JSON. Keys look like "rounds/r_abc", "seats/single/042", "wallets/0x...".
 *
 * Concurrency note: put() is last-write-wins. putIfAbsent() is atomic on every adapter and is what
 * seat claims use. Read-modify-write documents (wallets, vault, leaderboard, events) are serialised
 * per process by the game service; across several serverless instances they can race.
 * That is acceptable for play coins; move them to a database with transactions before real money.
 */
export interface Store {
  get<T>(key: string): Promise<T | null>;
  put(key: string, value: unknown): Promise<void>;
  /** Returns true if the key was created, false if it already existed. */
  putIfAbsent(key: string, value: unknown): Promise<boolean>;
  delete(key: string): Promise<void>;
  /** All keys that start with prefix. */
  list(prefix: string): Promise<string[]>;
}

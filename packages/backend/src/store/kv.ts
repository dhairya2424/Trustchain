/**
 * Minimal key-value surface the auth module needs.
 *
 * An interface rather than a direct ioredis import for one reason that matters: nonce
 * consumption and refresh-token rotation are security logic, and security logic that can
 * only be exercised with a live Redis tends not to be exercised at all. The in-memory
 * implementation lets every replay and reuse path be tested deterministically; production
 * uses Redis.
 */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;

  set(key: string, value: string, ttlSeconds: number): Promise<void>;

  /**
   * Atomically read and delete.
   *
   * Atomicity is the whole point: a get-then-delete pair lets two concurrent requests
   * both observe the same nonce before either removes it, which is exactly the replay
   * this is meant to prevent.
   */
  take(key: string): Promise<string | null>;

  delete(key: string): Promise<void>;
}

interface Entry {
  value: string;
  expiresAt: number;
}

/** For tests and single-process local development. */
export class MemoryStore implements KeyValueStore {
  private readonly entries = new Map<string, Entry>();

  private live(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;

    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async take(key: string): Promise<string | null> {
    const entry = this.live(key);
    if (!entry) return null;

    this.entries.delete(key);
    return entry.value;
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  /** Test seam: fast-forward past a TTL without waiting. */
  expire(key: string): void {
    const entry = this.entries.get(key);
    if (entry) entry.expiresAt = 0;
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Shape of the ioredis client we actually depend on, so it can be typed without importing it. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
  getdel(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
}

export class RedisStore implements KeyValueStore {
  constructor(private readonly redis: RedisLike) {}

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, value, "EX", ttlSeconds);
  }

  async take(key: string): Promise<string | null> {
    // GETDEL is atomic server-side; a GET followed by DEL is not.
    return this.redis.getdel(key);
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(key);
  }
}

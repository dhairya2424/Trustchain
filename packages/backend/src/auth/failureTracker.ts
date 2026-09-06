import type { KeyValueStore } from "../store/kv";

const FAILURE_KEY = (ip: string) => `auth:failures:${ip}`;
const BLOCK_KEY = (ip: string) => `auth:blocked:${ip}`;

export interface BlockState {
  blocked: boolean;
  retryAfterSeconds: number;
}

/**
 * Per-IP failure counting with exponential backoff.
 *
 * Distinct from the request rate limiter, and deliberately so. The rate limiter caps how
 * fast anyone may call /auth/*, including legitimate users. This tracks only *failed*
 * attempts, so an address that keeps signing in successfully is never penalised while an
 * address guessing signatures is shut out for exponentially longer each round.
 *
 * Backoff doubles from a base delay once the threshold is crossed, capped so an IP is
 * never blocked forever — a permanent block from an automated counter is a denial of
 * service against whoever inherits that address.
 */
export class FailureTracker {
  constructor(
    private readonly store: KeyValueStore,
    private readonly options: {
      threshold: number;
      baseSeconds: number;
      maxSeconds: number;
      windowSeconds: number;
    },
  ) {}

  /** Block duration after `failures` total failures. */
  blockSecondsFor(failures: number): number {
    if (failures < this.options.threshold) return 0;

    const excess = failures - this.options.threshold;
    const seconds = this.options.baseSeconds * 2 ** excess;

    return Math.min(seconds, this.options.maxSeconds);
  }

  async status(ip: string): Promise<BlockState> {
    const until = await this.store.get(BLOCK_KEY(ip));
    if (!until) return { blocked: false, retryAfterSeconds: 0 };

    const remaining = Math.ceil((Number(until) - Date.now()) / 1000);
    if (remaining <= 0) {
      await this.store.delete(BLOCK_KEY(ip));
      return { blocked: false, retryAfterSeconds: 0 };
    }

    return { blocked: true, retryAfterSeconds: remaining };
  }

  /** Records a failed attempt and applies a block once the threshold is reached. */
  async recordFailure(ip: string): Promise<BlockState> {
    const current = Number((await this.store.get(FAILURE_KEY(ip))) ?? 0) + 1;
    await this.store.set(FAILURE_KEY(ip), String(current), this.options.windowSeconds);

    const blockSeconds = this.blockSecondsFor(current);
    if (blockSeconds === 0) return { blocked: false, retryAfterSeconds: 0 };

    await this.store.set(
      BLOCK_KEY(ip),
      String(Date.now() + blockSeconds * 1000),
      Math.ceil(blockSeconds),
    );

    return { blocked: true, retryAfterSeconds: blockSeconds };
  }

  /** A successful sign-in clears the record — the caller has proven they are legitimate. */
  async recordSuccess(ip: string): Promise<void> {
    await this.store.delete(FAILURE_KEY(ip));
    await this.store.delete(BLOCK_KEY(ip));
  }
}

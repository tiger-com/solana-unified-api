/**
 * Token bucket sized to the API's documented per-wallet limits.
 *
 * The API allows 5 read and 5 write requests per second per wallet, counted
 * separately. Shaping requests here turns a burst into a short wait instead of
 * a `429` that the caller has to understand and retry.
 */
export class TokenBucket {
  #tokens: number;
  #lastRefillMs: number;
  readonly #capacity: number;
  readonly #refillPerMs: number;
  readonly #now: () => number;

  constructor(perSecond: number, now: () => number = Date.now) {
    this.#capacity = perSecond;
    this.#tokens = perSecond;
    this.#refillPerMs = perSecond / 1000;
    this.#now = now;
    this.#lastRefillMs = now();
  }

  /** Milliseconds to wait before a token is available; 0 when one is free now. */
  #delayMs(): number {
    const now = this.#now();
    this.#tokens = Math.min(
      this.#capacity,
      this.#tokens + (now - this.#lastRefillMs) * this.#refillPerMs,
    );
    this.#lastRefillMs = now;
    if (this.#tokens >= 1) return 0;
    return Math.ceil((1 - this.#tokens) / this.#refillPerMs);
  }

  /** Resolves once a token has been taken. */
  async acquire(sleep: (ms: number) => Promise<void>): Promise<void> {
    for (;;) {
      const delay = this.#delayMs();
      if (delay === 0) {
        this.#tokens -= 1;
        return;
      }
      await sleep(delay);
    }
  }
}

/** Read and write buckets, which the API counts independently. */
export class RateLimiter {
  readonly #read: TokenBucket;
  readonly #write: TokenBucket;

  constructor(readsPerSecond = 5, writesPerSecond = 5, now: () => number = Date.now) {
    this.#read = new TokenBucket(readsPerSecond, now);
    this.#write = new TokenBucket(writesPerSecond, now);
  }

  acquire(kind: "read" | "write", sleep: (ms: number) => Promise<void>): Promise<void> {
    return (kind === "read" ? this.#read : this.#write).acquire(sleep);
  }
}

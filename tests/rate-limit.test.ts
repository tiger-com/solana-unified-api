import { describe, expect, it } from "vitest";

import { RateLimiter, TokenBucket } from "../src/rate-limit.js";

/** Virtual clock so the tests assert on shaping, not on wall time. */
function clock() {
  let now = 0;
  const sleep = async (ms: number) => {
    now += ms;
  };
  return { now: () => now, sleep, advance: (ms: number) => (now += ms) };
}

describe("TokenBucket", () => {
  it("lets a full burst through without waiting", async () => {
    const time = clock();
    const bucket = new TokenBucket(5, time.now);

    for (let index = 0; index < 5; index++) await bucket.acquire(time.sleep);

    expect(time.now()).toBe(0);
  });

  it("delays the request past the burst instead of failing it", async () => {
    const time = clock();
    const bucket = new TokenBucket(5, time.now);

    for (let index = 0; index < 5; index++) await bucket.acquire(time.sleep);
    await bucket.acquire(time.sleep);

    // A sixth request inside one second waits for the bucket to refill.
    expect(time.now()).toBeGreaterThan(0);
    expect(time.now()).toBeLessThanOrEqual(200);
  });

  it("refills over time", async () => {
    const time = clock();
    const bucket = new TokenBucket(5, time.now);

    for (let index = 0; index < 5; index++) await bucket.acquire(time.sleep);
    time.advance(1000);
    const before = time.now();
    for (let index = 0; index < 5; index++) await bucket.acquire(time.sleep);

    expect(time.now()).toBe(before);
  });
});

describe("RateLimiter", () => {
  it("counts reads and writes independently, as the API does", async () => {
    const time = clock();
    const limiter = new RateLimiter(5, 5, time.now);

    for (let index = 0; index < 5; index++) await limiter.acquire("read", time.sleep);
    for (let index = 0; index < 5; index++) await limiter.acquire("write", time.sleep);

    expect(time.now()).toBe(0);
  });
});

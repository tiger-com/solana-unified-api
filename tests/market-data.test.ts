import { describe, expect, it } from "vitest";

import { PerpClient } from "../src/client.js";
import { challengeResponse, errorBody, stubRoutes, stubSigner, tokenResponse } from "./helpers.js";

const book = {
  venue: "PHX",
  market_id: "0",
  symbol: "SOL_USDC",
  updated_slot: 441_443_666,
  bids: [{ price: "95", quantity: "76.35" }],
  asks: [{ price: "95.02", quantity: "78.4" }],
};

const trade = (signature: string) => ({
  side: "S",
  quantity: "0.03",
  price: "95.04",
  quote_amount: "2.8512",
  occurred_at: "2026-08-24T17:29:22Z",
  signature,
});

const build = (routes: Record<string, unknown>) => {
  const { fetch, calls } = stubRoutes({
    "/wallet/challenges/verify": { body: tokenResponse() },
    "/wallet/challenges": { body: challengeResponse },
    ...routes,
  } as never);
  return {
    calls,
    client: new PerpClient({ signer: stubSigner(), fetch, rateLimit: null, retry: { maxRetries: 0 } }),
  };
};

describe("orderbook", () => {
  it("reads the book without a token", async () => {
    const { client, calls } = build({ "/markets/0/orderbook": { body: book } });

    const result = await client.discovery.orderbook("PHX", "0");

    expect(result.bids[0]!.price).toBe("95");
    expect(calls.at(-1)!.url).toBe(
      "https://sol-trading-api.tiger.com/v1/perp/venues/PHX/markets/0/orderbook",
    );
    // Public route: sending a token here would leak it for no reason.
    expect(calls.at(-1)!.headers["Authorization"]).toBeUndefined();
  });

  it("forwards depth and omits it when unset", async () => {
    const { client, calls } = build({ "/markets/0/orderbook": { body: book } });

    await client.discovery.orderbook("PHX", "0", { depth: 50 });
    expect(calls.at(-1)!.url).toContain("depth=50");

    await client.discovery.orderbook("PHX", "0");
    expect(calls.at(-1)!.url).not.toContain("depth");
  });

  it("surfaces the market-data rate limit as a retryable error", async () => {
    const { client } = build({
      "/markets/0/orderbook": {
        status: 429,
        body: errorBody("market_data_rate_limited", true, 1),
        headers: { "Retry-After": "1" },
      },
    });

    await expect(client.discovery.orderbook("PHX", "0")).rejects.toMatchObject({
      code: "market_data_rate_limited",
      retryAfterSeconds: 1,
      isRetryable: true,
    });
  });
});

describe("trades", () => {
  it("reads one page of the tape", async () => {
    const { client, calls } = build({
      "/markets/0/trades": {
        body: { ...book, trades: [trade("sig-1")], next_cursor: "c1", has_more: true },
      },
    });

    const page = await client.discovery.trades("PHX", "0", { limit: 2 });

    expect(page.trades).toHaveLength(1);
    expect(page.has_more).toBe(true);
    expect(calls.at(-1)!.url).toContain("limit=2");
  });

  it("walks pages until the tape is exhausted", async () => {
    const { client, calls } = build({
      "/markets/0/trades": [
        { body: { ...book, trades: [trade("a"), trade("b")], next_cursor: "c1", has_more: true } },
        { body: { ...book, trades: [trade("c")], has_more: false } },
      ],
    });

    const seen: string[] = [];
    for await (const entry of client.discovery.iterateTrades("PHX", "0")) {
      seen.push(entry.signature);
    }

    expect(seen).toEqual(["a", "b", "c"]);
    expect(calls.at(-1)!.url).toContain("cursor=c1");
  });

  it("stops when has_more is true but no cursor came back", async () => {
    const { client } = build({
      "/markets/0/trades": { body: { ...book, trades: [trade("a")], has_more: true } },
    });

    const seen: string[] = [];
    for await (const entry of client.discovery.iterateTrades("PHX", "0")) {
      seen.push(entry.signature);
    }

    // Without this guard the generator would loop forever on the same page.
    expect(seen).toEqual(["a"]);
  });
});

describe("capabilities", () => {
  it("exposes the market-data flags used to gate these routes", async () => {
    const { client } = build({
      "/v1/perp/venues": {
        body: {
          venues: [
            {
              venue: "PHX",
              capabilities: {
                orderbook: true,
                market_trades: true,
                orders: { preview: true, attached_protection: true, reduce_only_orders: true },
              },
            },
          ],
        },
      },
    });

    const venue = await client.discovery.venue("PHX");

    expect(venue?.capabilities?.orderbook).toBe(true);
    expect(venue?.capabilities?.market_trades).toBe(true);
    expect(venue?.capabilities?.orders?.preview).toBe(true);
    expect(venue?.capabilities?.orders?.attached_protection).toBe(true);
  });
});

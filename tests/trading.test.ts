import { describe, expect, it } from "vitest";

import { PerpClient } from "../src/client.js";
import { PerpUsageError } from "../src/errors.js";
import { MemoryIdempotencyStore } from "../src/stores.js";
import { challengeResponse, SOL_PERP, stubFetch, stubSigner, tokenResponse } from "./helpers.js";

const command = (state = "QUEUED") => ({
  command: {
    id: 1,
    request_id: "generated",
    kind: "PLACE_ORDER",
    payload: {},
    state,
    created_at: "2026-08-24T10:00:00Z",
    updated_at: "2026-08-24T10:00:00Z",
  },
  created: true,
});

const build = (script: Parameters<typeof stubFetch>[0], options = {}) => {
  const { fetch, calls } = stubFetch([
    { body: challengeResponse },
    { body: tokenResponse() },
    ...script,
  ]);
  const client = new PerpClient({
    signer: stubSigner(),
    fetch,
    rateLimit: null,
    retry: { maxRetries: 0 },
    ...options,
  });
  return { client, calls };
};

const marketOrder = {
  market_id: "0",
  side: "B" as const,
  kind: "MARKET" as const,
  execution_mode: "IOC" as const,
  quantity: "0.01",
};

describe("idempotency", () => {
  it("attaches a generated request_id to every intent", async () => {
    const { client, calls } = build([{ status: 202, body: command() }]);
    await client.trading.place("PHX", "acct", marketOrder);

    const sent = calls.at(-1)!.body as { request_id: string };
    expect(sent.request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("generates a distinct id per intent", async () => {
    const { client, calls } = build([{ status: 202, body: command() }]);
    await client.trading.place("PHX", "acct", marketOrder);
    await client.trading.place("PHX", "acct", marketOrder);

    const [first, second] = calls.slice(-2).map((call) => (call.body as { request_id: string }).request_id);
    expect(first).not.toBe(second);
  });

  it("reuses the id bound to an intentKey, so a resend cannot double-fill", async () => {
    const store = new MemoryIdempotencyStore();
    const { client, calls } = build([{ status: 202, body: command() }], {
      idempotencyStore: store,
    });

    await client.trading.place("PHX", "acct", marketOrder, { intentKey: "rebalance-1" });
    await client.trading.place("PHX", "acct", marketOrder, { intentKey: "rebalance-1" });

    const [first, second] = calls.slice(-2).map((call) => (call.body as { request_id: string }).request_id);
    expect(first).toBe(second);
    expect(await store.get("rebalance-1")).toBe(first);
  });

  it("honours an explicitly supplied request_id", async () => {
    const { client, calls } = build([{ status: 202, body: command() }]);
    const requestId = "9f1d5f7a-1c2b-4a3e-8f10-0b3d5c7e9a11";
    await client.trading.place("PHX", "acct", marketOrder, { requestId });

    expect((calls.at(-1)!.body as { request_id: string }).request_id).toBe(requestId);
  });

  it("rejects a request_id that is not canonical UUID text", async () => {
    const { client } = build([{ status: 202, body: command() }]);
    await expect(
      client.trading.place("PHX", "acct", marketOrder, { requestId: "not-a-uuid" }),
    ).rejects.toThrow(PerpUsageError);
  });
});

describe("order shape validation", () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["MARKET with GTC", { ...marketOrder, execution_mode: "GTC" }, /execution_mode IOC/],
    ["MARKET with a limit price", { ...marketOrder, limit_price: "1" }, /omit limit_price/],
    ["LIMIT without a limit price", { ...marketOrder, kind: "LIMIT", execution_mode: "GTC" }, /limit_price/],
    [
      "CONDITIONAL without a trigger price",
      { ...marketOrder, kind: "CONDITIONAL", execution_mode: "GTC" },
      /trigger_price/,
    ],
    [
      "stop-market with slippage",
      { ...marketOrder, kind: "CONDITIONAL", execution_mode: "GTC", trigger_price: "1", max_slippage_bps: 100 },
      /omit max_slippage_bps/,
    ],
    ["post_only on a market order", { ...marketOrder, post_only: true }, /post_only/],
  ];

  for (const [name, order, message] of cases) {
    it(`rejects ${name} before spending a request`, async () => {
      const { client, calls } = build([{ status: 202, body: command() }]);
      const before = calls.length;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(client.trading.place("PHX", "acct", order as any)).rejects.toThrow(message);
      expect(calls).toHaveLength(before);
    });
  }

  it("validates against a market when one is supplied", async () => {
    const { client } = build([{ status: 202, body: command() }]);
    await expect(
      client.trading.place("PHX", "acct", { ...marketOrder, quantity: "0.001" }, { market: SOL_PERP }),
    ).rejects.toThrow(/minimum_quantity/);
  });
});

describe("cancel", () => {
  it("requires exactly one of venue_order_ids and cancel_all", async () => {
    const { client } = build([{ status: 202, body: command() }]);

    await expect(client.trading.cancel("PHX", "acct", { market_id: "0" })).rejects.toThrow(
      /exactly one/,
    );
    await expect(
      client.trading.cancel("PHX", "acct", { market_id: "0", venue_order_ids: ["1"], cancel_all: true }),
    ).rejects.toThrow(/exactly one/);
  });

  it("rejects duplicate and oversized id lists", async () => {
    const { client } = build([{ status: 202, body: command() }]);

    await expect(
      client.trading.cancel("PHX", "acct", { market_id: "0", venue_order_ids: ["1", "1"] }),
    ).rejects.toThrow(/unique/);
    await expect(
      client.trading.cancel("PHX", "acct", {
        market_id: "0",
        venue_order_ids: Array.from({ length: 31 }, (_, index) => String(index)),
      }),
    ).rejects.toThrow(/1–30/);
  });

  it("accepts cancel_all", async () => {
    const { client, calls } = build([{ status: 202, body: command() }]);
    await client.trading.cancel("PHX", "acct", { market_id: "0", cancel_all: true });
    expect(calls.at(-1)!.url).toContain("/orders/cancel");
  });
});

describe("protection", () => {
  it("requires at least one price", async () => {
    const { client } = build([{ status: 202, body: command() }]);
    await expect(
      client.trading.setProtection("PHX", "acct", "0", { expected_snapshot_fingerprint: "f" }),
    ).rejects.toThrow(/take_profit_price or stop_loss_price/);
  });

  it("requires stop_loss_price alongside its slippage", async () => {
    const { client } = build([{ status: 202, body: command() }]);
    await expect(
      client.trading.setProtection("PHX", "acct", "0", {
        expected_snapshot_fingerprint: "f",
        take_profit_price: "180",
        stop_loss_slippage_bps: 100,
      }),
    ).rejects.toThrow(/requires stop_loss_price/);
  });
});

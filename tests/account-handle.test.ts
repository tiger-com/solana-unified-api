import { describe, expect, it } from "vitest";

import { PerpClient } from "../src/client.js";
import { PerpUsageError } from "../src/errors.js";
import { challengeResponse, stubRoutes, stubSigner, tokenResponse } from "./helpers.js";

const commandBody = (state: string) => ({
  id: 1,
  request_id: "9f1d5f7a-1c2b-4a3e-8f10-0b3d5c7e9a11",
  kind: "PLACE_ORDER",
  payload: {},
  state,
});

const authRoutes = {
  "/wallet/challenges/verify": { body: tokenResponse() },
  "/wallet/challenges": { body: challengeResponse },
};

const snapshot = {
  commitment: "confirmed",
  slot: 1,
  head_slot: 1,
  lag_slots: 0,
  observed_at: "2026-08-24T10:00:00Z",
  stale: false,
  fingerprint: "fp-1",
  balances: [],
  positions: [],
  orders: [],
};

const build = (routes: Record<string, unknown> = {}) => {
  const { fetch, calls } = stubRoutes({ ...authRoutes, ...routes } as never);
  return {
    calls,
    client: new PerpClient({ signer: stubSigner(), fetch, rateLimit: null, retry: { maxRetries: 0 } }),
  };
};

const marketOrder = {
  market_id: "0",
  side: "B" as const,
  kind: "MARKET" as const,
  execution_mode: "IOC" as const,
  quantity: "0.01",
};

describe("client.account", () => {
  it("binds from an account object", () => {
    const { client } = build();
    const handle = client.account({
      user_id: "owner",
      venue: "PHX",
      name: "Main",
      native_account: "acct",
      status: "ACTIVE",
      created_at: "2026-08-24T10:00:00Z",
      updated_at: "2026-08-24T10:00:00Z",
    });

    expect(handle.id).toEqual({ venue: "PHX", native_account: "acct" });
  });

  it("binds from an explicit pair", () => {
    const { client } = build();
    expect(client.account("PHX", "acct").nativeAccount).toBe("acct");
  });

  it("refuses a venue with no native account", () => {
    const { client } = build();
    // @ts-expect-error exercising the runtime guard behind the overloads
    expect(() => client.account("PHX")).toThrow(PerpUsageError);
  });

  it("performs no request when binding", () => {
    const { client, calls } = build();
    client.account("PHX", "acct");
    expect(calls).toHaveLength(0);
  });
});

describe("bound calls", () => {
  it("routes to the bound venue and account", async () => {
    const { client, calls } = build({
      "/venues/PHX/accounts/acct/orders": { body: { orders: [], snapshot } },
    });

    await client.account("PHX", "acct").orders({ marketId: "0" });

    expect(calls.at(-1)!.url).toContain("/v1/perp/venues/PHX/accounts/acct/orders");
    expect(calls.at(-1)!.url).toContain("market_id=0");
  });

  it("keeps two handles independent", async () => {
    const { client, calls } = build({
      "/venues/PHX/accounts/first/orders": { body: { orders: [], snapshot } },
      "/venues/VEL/accounts/second/orders": { body: { orders: [], snapshot } },
    });

    await client.account("PHX", "first").orders();
    await client.account("VEL", "second").orders();

    expect(calls.at(-2)!.url).toContain("/venues/PHX/accounts/first/");
    expect(calls.at(-1)!.url).toContain("/venues/VEL/accounts/second/");
  });

  it("produces the same request as the resource form", async () => {
    const routes = {
      "/venues/PHX/accounts/acct/orders": { status: 202, body: { command: commandBody("QUEUED"), created: true } },
    };
    const bound = build(routes);
    const direct = build(routes);

    await bound.client.account("PHX", "acct").place(marketOrder, { requestId: "9f1d5f7a-1c2b-4a3e-8f10-0b3d5c7e9a11" });
    await direct.client.trading.place("PHX", "acct", marketOrder, {
      requestId: "9f1d5f7a-1c2b-4a3e-8f10-0b3d5c7e9a11",
    });

    expect(bound.calls.at(-1)!.url).toBe(direct.calls.at(-1)!.url);
    expect(bound.calls.at(-1)!.body).toEqual(direct.calls.at(-1)!.body);
  });

  it("forwards cancelAll as a cancel_all instruction", async () => {
    const { client, calls } = build({
      "/venues/PHX/accounts/acct/orders/cancel": {
        status: 202,
        body: { command: commandBody("QUEUED"), created: true },
      },
    });

    await client.account("PHX", "acct").cancelAll("0");

    expect(calls.at(-1)!.url).toContain("/orders/cancel");
    expect(calls.at(-1)!.body).toMatchObject({ market_id: "0", cancel_all: true });
  });

  it("still validates locally before spending a request", async () => {
    const { client, calls } = build();
    const account = client.account("PHX", "acct");

    await expect(account.place({ ...marketOrder, post_only: true })).rejects.toThrow(
      PerpUsageError,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("SubmittedCommand.wait", () => {
  it("follows the command without the caller handling a request_id", async () => {
    const { client } = build({
      "/venues/PHX/accounts/acct/orders": {
        status: 202,
        body: { command: commandBody("QUEUED"), created: true },
      },
      "/venues/PHX/accounts/acct/commands/": [
        { body: { command: commandBody("SUBMITTED") } },
        { body: { command: commandBody("COMPLETED") } },
      ],
    });

    const order = await client.account("PHX", "acct").place(marketOrder);

    // The envelope is still visible: a 202 is durability, not execution.
    expect(order.command.state).toBe("QUEUED");
    expect(order.created).toBe(true);

    const settled = await order.wait({ pollIntervalMs: 1 });
    expect(settled.state).toBe("COMPLETED");
  });

  it("polls the same request_id it was admitted under", async () => {
    const { client, calls } = build({
      "/venues/PHX/accounts/acct/orders": {
        status: 202,
        body: { command: commandBody("QUEUED"), created: true },
      },
      "/venues/PHX/accounts/acct/commands/": { body: { command: commandBody("COMPLETED") } },
    });

    const order = await client.account("PHX", "acct").place(marketOrder);
    await order.wait({ pollIntervalMs: 1 });

    expect(calls.at(-1)!.url).toContain(`/commands/${order.command.request_id}`);
  });
});

describe("accountHandles", () => {
  it("binds every listed account", async () => {
    const { client } = build({
      "/v1/perp/accounts": {
        body: {
          accounts: [
            { venue: "PHX", native_account: "a", status: "ACTIVE" },
            { venue: "PHX", native_account: "b", status: "PAUSED" },
          ],
        },
      },
    });

    const handles = await client.accountHandles({ venue: "PHX" });

    expect(handles.map((handle) => handle.nativeAccount)).toEqual(["a", "b"]);
  });
});

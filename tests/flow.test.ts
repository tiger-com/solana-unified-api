import { describe, expect, it } from "vitest";

import { PerpClient } from "../src/client.js";
import { challengeResponse, SOL_PERP, stubRoutes, stubSigner, tokenResponse } from "./helpers.js";

const snapshot = (stale: boolean, fingerprint = "fp-1") => ({
  commitment: "confirmed",
  slot: 1,
  head_slot: 1,
  lag_slots: 0,
  observed_at: "2026-08-24T10:00:00Z",
  stale,
  ...(stale ? { retry_after_seconds: 0 } : {}),
  fingerprint,
  balances: [],
  positions: [],
  orders: [],
});

const authRoutes = {
  "/wallet/challenges/verify": { body: tokenResponse() },
  "/wallet/challenges": { body: challengeResponse },
};

const commandBody = (state: string) => ({
  id: 1,
  request_id: "9f1d5f7a-1c2b-4a3e-8f10-0b3d5c7e9a11",
  kind: "PLACE_ORDER",
  payload: {},
  state,
});

describe("quickstart flow", () => {
  it("goes from login to a settled order using one wallet signature", async () => {
    const { fetch, calls } = stubRoutes({
      ...authRoutes,
      "/v1/perp/venues": {
        body: { venues: [{ venue: "PHX", capabilities: { orders: { market_ioc: true } } }] },
      },
      "/v1/perp/markets": { body: { markets: [SOL_PERP] } },
      "/v1/perp/accounts": {
        body: { accounts: [{ venue: "PHX", native_account: "acct", status: "ACTIVE" }] },
      },
      "/venues/PHX/accounts/acct": { body: { account: { status: "ACTIVE" }, state: snapshot(false) } },
      "/venues/PHX/accounts/acct/orders": {
        status: 202,
        body: { command: commandBody("QUEUED"), created: true },
      },
      "/venues/PHX/accounts/acct/commands/": [
        { body: { command: commandBody("SUBMITTED") } },
        { body: { command: commandBody("COMPLETED") } },
      ],
    });

    const signer = stubSigner();
    const client = new PerpClient({ signer, fetch, rateLimit: null });

    const venues = await client.discovery.venues();
    expect(venues[0]!.capabilities?.orders?.market_ioc).toBe(true);

    const [market] = await client.discovery.markets("PHX");
    const [account] = await client.accounts.list({ venue: "PHX" });

    const state = await client.freshState("PHX", account!.native_account);
    expect(state.stale).toBe(false);

    const { command } = await client.trading.place(
      "PHX",
      account!.native_account,
      {
        market_id: market!.market_id,
        side: "B",
        kind: "MARKET",
        execution_mode: "IOC",
        quantity: "0.01",
        max_slippage_bps: 100,
      },
      { market: market! },
    );

    const settled = await client.commands.waitForTerminal(
      "PHX",
      account!.native_account,
      command.request_id,
      { pollIntervalMs: 1 },
    );

    expect(settled.state).toBe("COMPLETED");
    // Discovery is public; every authenticated call reused one token.
    expect(signer.prompts()).toBe(1);

    const orderCall = calls.find((call) => call.url.endsWith("/orders"))!;
    expect((orderCall.body as { request_id: string }).request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(orderCall.headers["Authorization"]).toBe("Bearer test-access-token");
  });

  it("does not send a token to public discovery routes", async () => {
    const { fetch, calls } = stubRoutes({
      ...authRoutes,
      "/v1/perp/venues": { body: { venues: [] } },
    });
    const client = new PerpClient({ signer: stubSigner(), fetch, rateLimit: null });

    await client.login();
    await client.discovery.venues();

    const venueCall = calls.find((call) => call.url.includes("/venues"))!;
    expect(venueCall.headers["Authorization"]).toBeUndefined();
  });
});

describe("snapshot freshness", () => {
  it("retries past a stale snapshot rather than fingerprinting a command with it", async () => {
    const { fetch, calls } = stubRoutes({
      ...authRoutes,
      "/venues/PHX/accounts/acct": [
        { body: { account: { status: "ACTIVE" }, state: snapshot(true) } },
        { body: { account: { status: "ACTIVE" }, state: snapshot(false, "fp-fresh") } },
      ],
    });
    const client = new PerpClient({ signer: stubSigner(), fetch, rateLimit: null });

    const state = await client.freshState("PHX", "acct");

    expect(state.fingerprint).toBe("fp-fresh");
    expect(calls.filter((call) => call.url.includes("/accounts/acct"))).toHaveLength(2);
  });

  it("gives up rather than returning a stale snapshot", async () => {
    const { fetch } = stubRoutes({
      ...authRoutes,
      "/venues/PHX/accounts/acct": { body: { account: { status: "ACTIVE" }, state: snapshot(true) } },
    });
    const client = new PerpClient({ signer: stubSigner(), fetch, rateLimit: null });

    await expect(client.freshState("PHX", "acct", { attempts: 2 })).rejects.toThrow(
      /fresh snapshot/,
    );
  });
});

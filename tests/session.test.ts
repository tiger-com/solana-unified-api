import { describe, expect, it } from "vitest";

import { PerpClient } from "../src/client.js";
import { PerpAuthError } from "../src/errors.js";
import { challengeResponse, errorBody, stubFetch, stubSigner, tokenResponse } from "./helpers.js";

const build = (script: Parameters<typeof stubFetch>[0], options = {}) => {
  const { fetch, calls } = stubFetch(script);
  const signer = stubSigner();
  const client = new PerpClient({
    environment: "development",
    signer,
    fetch,
    rateLimit: null,
    retry: { maxRetries: 0 },
    ...options,
  });
  return { client, calls, signer };
};

describe("login", () => {
  it("signs the challenge message bytes verbatim", async () => {
    const captured: Uint8Array[] = [];
    const signer = {
      publicKey: "owner",
      async signMessage(message: Uint8Array) {
        captured.push(message);
        return new Uint8Array(64);
      },
    };
    const { fetch } = stubFetch([{ body: challengeResponse }, { body: tokenResponse() }]);
    const client = new PerpClient({ signer, fetch, rateLimit: null });

    await client.login();

    expect(new TextDecoder().decode(captured[0])).toBe(challengeResponse.message);
  });

  it("reuses a cached token instead of prompting again", async () => {
    const { client, signer, calls } = build([
      { body: challengeResponse },
      { body: tokenResponse() },
      { body: { accounts: [] } },
    ]);

    await client.login();
    await client.accounts.list();
    await client.accounts.list();

    expect(signer.prompts()).toBe(1);
    expect(calls.filter((call) => call.url.includes("/wallet/challenges"))).toHaveLength(2);
  });

  it("collapses concurrent logins into one wallet prompt", async () => {
    const { client, signer } = build([
      { body: challengeResponse },
      { body: tokenResponse() },
      { body: { accounts: [] } },
    ]);

    await Promise.all([client.login(), client.login(), client.login()]);

    expect(signer.prompts()).toBe(1);
  });

  it("renews a token that is inside the renewal margin", async () => {
    const { client, signer } = build(
      [
        { body: challengeResponse },
        { body: tokenResponse(30_000) }, // expires sooner than the margin
        { body: challengeResponse },
        { body: tokenResponse(3_600_000) },
        { body: { accounts: [] } },
      ],
      { renewBeforeMs: 60_000 },
    );

    await client.login();
    await client.accounts.list();

    expect(signer.prompts()).toBe(2);
  });

  it("fails without prompting when onAuthRequired declines", async () => {
    const { client, signer } = build([{ body: challengeResponse }], {
      onAuthRequired: () => false,
    });

    await expect(client.login()).rejects.toThrow(PerpAuthError);
    expect(signer.prompts()).toBe(0);
  });

  it("reports why authentication is needed", async () => {
    const reasons: string[] = [];
    const { client } = build([{ body: challengeResponse }, { body: tokenResponse() }], {
      onAuthRequired: (context: { reason: string }) => {
        reasons.push(context.reason);
        return true;
      },
    });

    await client.login();
    expect(reasons).toEqual(["missing"]);
  });
});

describe("logout", () => {
  it("forces a new login on the next call", async () => {
    const { client, signer } = build([
      { body: challengeResponse },
      { body: tokenResponse() },
      { body: challengeResponse },
      { body: tokenResponse() },
    ]);

    await client.login();
    await client.logout();
    await client.login();

    expect(signer.prompts()).toBe(2);
  });
});

describe("environments", () => {
  it("refuses production until its endpoints are published", () => {
    expect(
      () => new PerpClient({ environment: "production", signer: stubSigner() }),
    ).toThrow(/not published/);
  });

  it("accepts explicit endpoints for an unpublished environment", () => {
    const client = new PerpClient({
      environment: "production",
      endpoints: { core: "https://a", ledger: "https://b", websocket: "wss://c" },
      signer: stubSigner(),
    });
    expect(client.endpoints.core).toBe("https://a");
  });

  it("defaults to development hosts", () => {
    const { client } = build([{ body: {} }]);
    expect(client.endpoints.core).toBe("https://sol-trading-api.tiger.com");
    expect(client.endpoints.ledger).toBe("https://sol-history-api.tiger.com");
  });
});

describe("unauthorized handling", () => {
  it("re-authenticates once when the API rejects a stale token", async () => {
    const { client, signer } = build([
      { body: challengeResponse },
      { body: tokenResponse() },
      { status: 401, body: errorBody("unauthorized") },
      { body: challengeResponse },
      { body: tokenResponse() },
      { body: { accounts: [] } },
    ]);

    await client.login();
    await expect(client.accounts.list()).resolves.toEqual([]);
    expect(signer.prompts()).toBe(2);
  });
});

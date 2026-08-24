import { describe, expect, it } from "vitest";

import { PerpApiError, PerpCommandError, PerpTransportError } from "../src/errors.js";
import { HttpClient } from "../src/http.js";
import { errorBody, stubFetch } from "./helpers.js";

const client = (script: Parameters<typeof stubFetch>[0], overrides = {}) => {
  const { fetch, calls } = stubFetch(script);
  return {
    calls,
    http: new HttpClient({
      coreBaseUrl: "https://core.test",
      ledgerBaseUrl: "https://ledger.test",
      fetch,
      rateLimiter: null,
      retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 },
      ...overrides,
    }),
  };
};

describe("routing", () => {
  it("sends ledger routes to the ledger host", async () => {
    const { http, calls } = client([{ body: { events: [] } }]);
    await http.request({ method: "GET", path: "/v1/perp/x", host: "ledger" });
    expect(calls[0]!.url).toBe("https://ledger.test/v1/perp/x");
  });

  it("omits undefined query parameters instead of sending 'undefined'", async () => {
    const { http, calls } = client([{ body: {} }]);
    await http.request({
      method: "GET",
      path: "/v1/perp/accounts",
      query: { venue: "PHX", status: undefined },
    });
    expect(calls[0]!.url).toBe("https://core.test/v1/perp/accounts?venue=PHX");
  });

  it("sends no body for routes that take none", async () => {
    const { http, calls } = client([{ body: {} }]);
    await http.request({ method: "POST", path: "/v1/perp/x/disable" });
    expect(calls[0]!.body).toBeUndefined();
    expect(calls[0]!.headers["Content-Type"]).toBeUndefined();
  });
});

describe("retries", () => {
  it("retries a retryable error and honours retry_after_seconds", async () => {
    const { http, calls } = client([
      { status: 503, body: errorBody("dependency_unavailable", true, 0) },
      { status: 200, body: { ok: true } },
    ]);
    await expect(http.request({ method: "GET", path: "/x" })).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it("does not retry a non-retryable error", async () => {
    const { http, calls } = client([{ status: 409, body: errorBody("stale_state") }]);
    await expect(http.request({ method: "GET", path: "/x" })).rejects.toThrow(PerpApiError);
    expect(calls).toHaveLength(1);
  });

  it("gives up after maxRetries and surfaces the last error", async () => {
    const { http, calls } = client([
      { status: 503, body: errorBody("venue_data_unavailable", true, 0) },
    ]);
    await expect(http.request({ method: "GET", path: "/x" })).rejects.toMatchObject({
      code: "venue_data_unavailable",
    });
    expect(calls).toHaveLength(3); // first attempt plus two retries
  });

  it("replays a transport failure only when the request is idempotent", async () => {
    const failure = { throws: new TypeError("network down") };

    const safe = client([failure, { body: { ok: true } }]);
    await expect(
      safe.http.request({ method: "POST", path: "/x", body: {}, idempotent: true }),
    ).resolves.toEqual({ ok: true });
    expect(safe.calls).toHaveLength(2);

    const unsafe = client([failure]);
    await expect(
      unsafe.http.request({ method: "POST", path: "/x", body: {}, idempotent: false }),
    ).rejects.toThrow(PerpTransportError);
    expect(unsafe.calls).toHaveLength(1);
  });
});

describe("command-bearing failures", () => {
  const stored = {
    command: { id: 1, request_id: "r", kind: "PLACE_ORDER", payload: {}, state: "SUBMITTED" },
    ...errorBody("transaction_not_submitted", true, 1),
  };

  it("raises PerpCommandError instead of retrying, so the caller polls", async () => {
    const { http, calls } = client([{ status: 503, body: stored }]);
    const error = await http
      .request({ method: "POST", path: "/orders", body: {}, idempotent: true })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PerpCommandError);
    expect((error as PerpCommandError).command.request_id).toBe("r");
    // Retrying here risks a second fill; exactly one attempt must be made.
    expect(calls).toHaveLength(1);
  });
});

describe("authentication", () => {
  it("re-authenticates once on 401 and replays the request", async () => {
    let reauth = 0;
    const { http, calls } = client(
      [{ status: 401, body: errorBody("unauthorized") }, { body: { ok: true } }],
      {
        getToken: async () => "token",
        onUnauthorized: async () => {
          reauth++;
          return true;
        },
      },
    );
    await expect(http.request({ method: "GET", path: "/x", auth: true })).resolves.toEqual({
      ok: true,
    });
    expect(reauth).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers["Authorization"]).toBe("Bearer token");
  });

  it("stops after one failed re-authentication", async () => {
    const { http, calls } = client([{ status: 401, body: errorBody("unauthorized") }], {
      getToken: async () => "token",
      onUnauthorized: async () => false,
    });
    await expect(http.request({ method: "GET", path: "/x", auth: true })).rejects.toMatchObject({
      status: 401,
    });
    expect(calls).toHaveLength(1);
  });

  it("never attaches a token to a public route", async () => {
    const { http, calls } = client([{ body: {} }], { getToken: async () => "token" });
    await http.request({ method: "GET", path: "/venues", auth: false });
    expect(calls[0]!.headers["Authorization"]).toBeUndefined();
  });
});

describe("malformed responses", () => {
  it("reports a non-JSON body as a transport failure", async () => {
    const { fetch } = stubFetch([]);
    void fetch;
    const http = new HttpClient({
      coreBaseUrl: "https://core.test",
      ledgerBaseUrl: "https://ledger.test",
      rateLimiter: null,
      retry: { maxRetries: 0 },
      fetch: (async () => new Response("<html>502 Bad Gateway</html>", { status: 502 })) as typeof globalThis.fetch,
    });
    await expect(http.request({ method: "GET", path: "/x" })).rejects.toThrow(PerpTransportError);
  });
});

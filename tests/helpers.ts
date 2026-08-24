import type { Market } from "../src/types.js";

export interface StubResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Throw instead of responding, simulating a transport failure. */
  throws?: Error;
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * A `fetch` stand-in that replays a queued script and records what it was
 * called with. The last entry repeats once the queue drains, so a test only
 * scripts the responses it cares about.
 */
export function stubFetch(script: StubResponse[]): {
  fetch: typeof globalThis.fetch;
  calls: RecordedRequest[];
} {
  const calls: RecordedRequest[] = [];
  let index = 0;

  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const step = script[Math.min(index, script.length - 1)]!;
    index++;

    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: { ...((init?.headers as Record<string, string>) ?? {}) },
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });

    if (step.throws) throw step.throws;

    return new Response(step.body === undefined ? "" : JSON.stringify(step.body), {
      status: step.status ?? 200,
      headers: { "Content-Type": "application/json", ...step.headers },
    });
  }) as typeof globalThis.fetch;

  return { fetch, calls };
}

/**
 * A `fetch` stand-in that answers by URL fragment rather than by call order.
 *
 * Flow tests interleave public and authenticated routes, so a strictly
 * sequential script breaks whenever the order of unrelated calls changes.
 * Each key may hold a queue; the last entry repeats once the queue drains.
 */
export function stubRoutes(routes: Record<string, StubResponse | StubResponse[]>): {
  fetch: typeof globalThis.fetch;
  calls: RecordedRequest[];
} {
  const queues = new Map<string, StubResponse[]>(
    Object.entries(routes).map(([key, value]) => [key, Array.isArray(value) ? [...value] : [value]]),
  );
  const calls: RecordedRequest[] = [];

  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: { ...((init?.headers as Record<string, string>) ?? {}) },
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });

    const matches = [...queues.keys()]
      .filter((candidate) => url.includes(candidate))
      // Longest match wins, so "/orders/cancel" beats "/orders".
      .sort((a, b) => b.length - a.length);

    const key = matches[0];
    if (!key) throw new Error(`no stub route matches ${url}`);
    if (matches[1] && matches[1].length === key.length) {
      // Silently picking one of two equally specific routes hides test bugs.
      throw new Error(
        `ambiguous stub routes for ${url}: ${matches[0]} and ${matches[1]} are equally specific`,
      );
    }

    const queue = queues.get(key)!;
    const step = queue.length > 1 ? queue.shift()! : queue[0]!;

    if (step.throws) throw step.throws;
    return new Response(step.body === undefined ? "" : JSON.stringify(step.body), {
      status: step.status ?? 200,
      headers: { "Content-Type": "application/json", ...step.headers },
    });
  }) as typeof globalThis.fetch;

  return { fetch, calls };
}

export const OWNER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

/** A signer that records how many times the wallet was asked to sign. */
export function stubSigner(): { publicKey: string; signMessage: () => Promise<Uint8Array>; prompts: () => number } {
  let prompts = 0;
  return {
    publicKey: OWNER,
    async signMessage() {
      prompts++;
      return new Uint8Array(64).fill(7);
    },
    prompts: () => prompts,
  };
}

export const tokenResponse = (expiresInMs = 3_600_000) => ({
  access_token: "test-access-token",
  token_type: "Bearer",
  expires_at: new Date(Date.now() + expiresInMs).toISOString(),
});

export const challengeResponse = {
  message: "sol-trading-api.tiger.com wants you to sign in\nnonce: abc",
  nonce: "abc",
  issued_at: "2026-08-24T10:00:00Z",
  expires_at: "2026-08-24T10:05:00Z",
  domain: "sol-trading-api.tiger.com",
  cluster: "mainnet-beta",
  challenge_token: "challenge-token",
};

export const errorBody = (
  code: string,
  retryable = false,
  retryAfterSeconds?: number,
): { error: { code: string; message: string; retryable: boolean; retry_after_seconds?: number } } => ({
  error: {
    code,
    message: code.replace(/_/g, " "),
    retryable,
    ...(retryAfterSeconds === undefined ? {} : { retry_after_seconds: retryAfterSeconds }),
  },
});

export const SOL_PERP: Market = {
  venue: "PHX",
  market_id: "0",
  symbol: "SOL_USDC",
  base_asset: "SOL",
  quote_asset: "USDC",
  name: "Solana Perpetual",
  price_tick: "0.01",
  price_decimals: 2,
  quantity_step: "0.001",
  quantity_decimals: 3,
  minimum_quantity: "0.01",
  minimum_notional: "10",
  max_leverage: "20",
  default_maker_fee_rate: "-0.00005",
  default_taker_fee_rate: "0.0004",
  funding_interval_seconds: 3600,
  contract_value: "1",
  contract_size_decimals: 0,
  trading_supported: true,
  isolated_only: false,
  capabilities: {},
};

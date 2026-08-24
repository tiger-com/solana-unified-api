import {
  PerpApiError,
  PerpCommandError,
  PerpTransportError,
  type ErrorCode,
} from "./errors.js";
import { RateLimiter } from "./rate-limit.js";
import { backoffMs, sleep } from "./sleep.js";
import type { ApiErrorBody, Command } from "./types.js";

/** Which host serves a route. Ledger and realtime live on their own host. */
export type Host = "core" | "ledger";

export interface RetryPolicy {
  /** Attempts after the first one. `0` disables retrying. */
  maxRetries: number;
  /** Base for full-jitter backoff when the response carries no `Retry-After`. */
  baseDelayMs: number;
  /** Upper bound for a single backoff wait. */
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 250,
  maxDelayMs: 4000,
};

export interface RequestSpec {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  host?: Host;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Whether to attach the wallet bearer token. */
  auth?: boolean;
  /** Which rate-limit bucket this request draws from. */
  kind?: "read" | "write";
  /**
   * Whether replaying the exact request is harmless.
   *
   * Only idempotent requests are retried after a transport failure, where the
   * server may have processed the first attempt. `disable`/`enable` are the
   * notable non-idempotent routes.
   */
  idempotent?: boolean;
  signal?: AbortSignal | undefined;
}

export interface HttpClientOptions {
  coreBaseUrl: string;
  ledgerBaseUrl: string;
  /** Returns a bearer token, refreshing it if needed. */
  getToken?: (() => Promise<string | undefined>) | undefined;
  /** Called with `401` so the session can re-authenticate once and retry. */
  onUnauthorized?: (() => Promise<boolean>) | undefined;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  retry?: Partial<RetryPolicy>;
  rateLimiter?: RateLimiter | null;
  /** Extra headers sent on every request, e.g. a partner identifier. */
  headers?: Record<string, string>;
}

/** Errors that mean "your durable command is fine, go poll it". */
const COMMAND_BEARING_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  "transaction_not_submitted",
  "submission_unknown",
  "gateway_protocol_error",
]);

const buildQuery = (query: RequestSpec["query"]): string => {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.append(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
};

const isErrorEnvelope = (value: unknown): value is { error: ApiErrorBody } =>
  typeof value === "object" &&
  value !== null &&
  "error" in value &&
  typeof (value as { error: unknown }).error === "object";

const hasCommand = (value: unknown): value is { command: Command } =>
  typeof value === "object" &&
  value !== null &&
  "command" in value &&
  typeof (value as { command: unknown }).command === "object";

/**
 * The transport every resource goes through: rate limiting, auth, timeouts,
 * retries, and error mapping.
 */
export class HttpClient {
  readonly #options: Required<
    Pick<HttpClientOptions, "coreBaseUrl" | "ledgerBaseUrl" | "timeoutMs" | "headers">
  >;
  readonly #fetch: typeof globalThis.fetch;
  readonly #retry: RetryPolicy;
  readonly #limiter: RateLimiter | null;
  #getToken: (() => Promise<string | undefined>) | undefined;
  #onUnauthorized: (() => Promise<boolean>) | undefined;

  constructor(options: HttpClientOptions) {
    this.#options = {
      coreBaseUrl: options.coreBaseUrl.replace(/\/+$/, ""),
      ledgerBaseUrl: options.ledgerBaseUrl.replace(/\/+$/, ""),
      timeoutMs: options.timeoutMs ?? 65_000,
      headers: options.headers ?? {},
    };
    // Bind so a passed-in `fetch` cannot lose its receiver in some runtimes.
    const source = options.fetch ?? globalThis.fetch;
    this.#fetch = source.bind(globalThis);
    this.#retry = { ...DEFAULT_RETRY_POLICY, ...options.retry };
    this.#limiter = options.rateLimiter === null ? null : (options.rateLimiter ?? new RateLimiter());
    this.#getToken = options.getToken;
    this.#onUnauthorized = options.onUnauthorized;
  }

  /** Wired after construction: the session needs the client to log in. */
  setAuth(handlers: {
    getToken: () => Promise<string | undefined>;
    onUnauthorized: () => Promise<boolean>;
  }): void {
    this.#getToken = handlers.getToken;
    this.#onUnauthorized = handlers.onUnauthorized;
  }

  baseUrl(host: Host = "core"): string {
    return host === "ledger" ? this.#options.ledgerBaseUrl : this.#options.coreBaseUrl;
  }

  async request<T>(spec: RequestSpec): Promise<T> {
    const url = this.baseUrl(spec.host) + spec.path + buildQuery(spec.query);
    const kind = spec.kind ?? (spec.method === "GET" ? "read" : "write");
    // Routes are authenticated unless they explicitly opt out, so the token
    // attachment in #send and the 401 recovery below stay in agreement.
    const authenticated = spec.auth !== false;
    let reauthenticated = false;

    for (let attempt = 0; ; attempt++) {
      if (this.#limiter) {
        await this.#limiter.acquire(kind, (ms) => sleep(ms, spec.signal));
      }

      let response: Response;
      try {
        response = await this.#send(url, spec);
      } catch (cause) {
        // A transport failure leaves the outcome unknown. Replaying is only
        // safe when the request is idempotent.
        if (spec.idempotent && attempt < this.#retry.maxRetries) {
          await sleep(backoffMs(attempt, this.#retry.baseDelayMs, this.#retry.maxDelayMs), spec.signal);
          continue;
        }
        if (cause instanceof PerpTransportError) throw cause;
        throw new PerpTransportError(`request to ${spec.path} failed`, { cause });
      }

      const payload = await this.#readBody(response);

      if (response.ok) return payload as T;

      // One silent re-authentication, then the caller sees the 401.
      if (response.status === 401 && !reauthenticated && authenticated && this.#onUnauthorized) {
        reauthenticated = true;
        if (await this.#onUnauthorized()) {
          attempt -= 1; // a refreshed token is not a failed attempt
          continue;
        }
      }

      const error = this.#toError(response, payload, spec.path);

      // A stored command must be polled, never replaced or resent.
      if (error instanceof PerpCommandError) throw error;

      if (error.isRetryable && attempt < this.#retry.maxRetries) {
        const hinted = error.retryAfterSeconds;
        const delay =
          hinted !== undefined
            ? hinted * 1000
            : backoffMs(attempt, this.#retry.baseDelayMs, this.#retry.maxDelayMs);
        await sleep(delay, spec.signal);
        continue;
      }
      throw error;
    }
  }

  async #send(url: string, spec: RequestSpec): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#options.timeoutMs);
    const onExternalAbort = () => controller.abort();
    spec.signal?.addEventListener("abort", onExternalAbort, { once: true });

    const headers: Record<string, string> = {
      Accept: "application/json",
      ...this.#options.headers,
    };
    if (spec.body !== undefined) headers["Content-Type"] = "application/json";
    if (spec.auth !== false && this.#getToken) {
      const token = await this.#getToken();
      if (token) headers["Authorization"] = `Bearer ${token}`;
    }

    try {
      return await this.#fetch(url, {
        method: spec.method,
        headers,
        // Routes documented as taking no body must not send one.
        body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
        signal: controller.signal,
      });
    } catch (cause) {
      if (controller.signal.aborted && !spec.signal?.aborted) {
        throw new PerpTransportError(
          `request to ${spec.path} timed out after ${this.#options.timeoutMs}ms`,
          { cause },
        );
      }
      throw cause;
    } finally {
      clearTimeout(timer);
      spec.signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  async #readBody(response: Response): Promise<unknown> {
    if (response.status === 204) return undefined;
    const text = await response.text();
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      // A non-JSON body means a proxy or gateway answered, not the API.
      throw new PerpTransportError(
        `unexpected non-JSON response (HTTP ${response.status})`,
      );
    }
  }

  #toError(response: Response, payload: unknown, path: string): PerpApiError {
    const header = response.headers.get("Retry-After");
    const retryAfterHeader = header === null ? undefined : Number(header);
    const body: ApiErrorBody = isErrorEnvelope(payload)
      ? payload.error
      : { code: "system_error", message: `HTTP ${response.status}`, retryable: false };

    const init = {
      status: response.status,
      body,
      path,
      retryAfterHeader: Number.isFinite(retryAfterHeader) ? retryAfterHeader : undefined,
    };

    if (hasCommand(payload) && COMMAND_BEARING_CODES.has(body.code)) {
      return new PerpCommandError({ ...init, command: payload.command });
    }
    return new PerpApiError(init);
  }
}

import { AccountHandle } from "./account-handle.js";
import { API_PREFIX, resolveEndpoints, type Endpoints, type EnvironmentName } from "./config.js";
import { PerpUsageError } from "./errors.js";
import { HttpClient, type RetryPolicy } from "./http.js";
import { RateLimiter } from "./rate-limit.js";
import { AccountsResource } from "./resources/accounts.js";
import { CollateralResource } from "./resources/collateral.js";
import { CommandsResource } from "./resources/commands.js";
import { DiscoveryResource } from "./resources/discovery.js";
import { HistoryResource } from "./resources/history.js";
import { TradingResource } from "./resources/trading.js";
import { WalletSession, type SessionOptions } from "./session.js";
import type { PerpSigner } from "./signer.js";
import {
  MemoryIdempotencyStore,
  type IdempotencyStore,
  type TokenStore,
} from "./stores.js";
import type { Account, AccountSnapshot, Venue } from "./types.js";

export interface PerpClientOptions {
  /** Named deployment. Defaults to `development`. */
  environment?: EnvironmentName;
  /** Explicit hosts; required for deployments with no published endpoints. */
  endpoints?: Partial<Endpoints>;
  /** Wallet that signs the login challenge. */
  signer: PerpSigner;
  /** Where the access token lives. Defaults to memory only. */
  tokenStore?: TokenStore;
  /**
   * Where trading idempotency keys live. Defaults to memory.
   *
   * Supply a durable implementation if intents must survive a process restart.
   */
  idempotencyStore?: IdempotencyStore;
  /** Called before the SDK asks the wallet to sign a login challenge. */
  onAuthRequired?: SessionOptions["onAuthRequired"];
  /** Renew the token this long before expiry. Defaults to 60 s. */
  renewBeforeMs?: number;
  /** Per-request timeout. Defaults to 65 s, just past the API's 60 s. */
  timeoutMs?: number;
  /** Retry behaviour for retryable failures. */
  retry?: Partial<RetryPolicy>;
  /**
   * Client-side throttling. Defaults to the documented 5 reads and 5 writes per
   * second per wallet. Pass `null` to disable and handle `429` yourself.
   */
  rateLimit?: { readsPerSecond: number; writesPerSecond: number } | null;
  /** Replaces the global `fetch`, for tests or a custom agent. */
  fetch?: typeof globalThis.fetch;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
}

/**
 * Entry point for the unified perpetuals API.
 *
 * ```ts
 * const client = new PerpClient({ signer });
 * const [account] = await client.accounts.list({ venue: "PHX" });
 * ```
 *
 * The client authenticates lazily: the first call needing a token triggers one
 * wallet signature, and concurrent calls share it.
 */
export class PerpClient {
  readonly endpoints: Endpoints;
  readonly session: WalletSession;

  readonly discovery: DiscoveryResource;
  readonly accounts: AccountsResource;
  readonly collateral: CollateralResource;
  readonly trading: TradingResource;
  readonly commands: CommandsResource;
  readonly history: HistoryResource;

  readonly #http: HttpClient;

  constructor(options: PerpClientOptions) {
    this.endpoints = resolveEndpoints(options.environment, options.endpoints);

    this.#http = new HttpClient({
      coreBaseUrl: this.endpoints.core,
      ledgerBaseUrl: this.endpoints.ledger,
      timeoutMs: options.timeoutMs,
      retry: options.retry,
      fetch: options.fetch,
      headers: options.headers,
      rateLimiter:
        options.rateLimit === null
          ? null
          : new RateLimiter(
              options.rateLimit?.readsPerSecond ?? 5,
              options.rateLimit?.writesPerSecond ?? 5,
            ),
    });

    this.session = new WalletSession(this.#http, {
      signer: options.signer,
      tokenStore: options.tokenStore,
      renewBeforeMs: options.renewBeforeMs,
      onAuthRequired: options.onAuthRequired,
    });

    // The session needs the transport to log in, and the transport needs the
    // session for tokens; wiring after construction breaks the cycle.
    this.#http.setAuth({
      getToken: () => this.session.peek(),
      onUnauthorized: () => this.session.reauthenticate(),
    });

    const idempotency = options.idempotencyStore ?? new MemoryIdempotencyStore();

    this.discovery = new DiscoveryResource(this.#http);
    this.accounts = new AccountsResource(this.#http);
    this.collateral = new CollateralResource(this.#http);
    this.trading = new TradingResource(this.#http, idempotency);
    this.commands = new CommandsResource(this.#http);
    this.history = new HistoryResource(this.#http);
  }

  /** Owner wallet public key; also the `user_id` in every response. */
  get owner(): string {
    return this.session.owner;
  }

  /**
   * Binds a client to one `(venue, native_account)` pair.
   *
   * Every account-scoped call then drops both arguments, which removes the
   * repetition and the hazard of transposing two `string` parameters that a
   * type checker cannot tell apart:
   *
   * ```ts
   * const [found] = await client.accounts.list({ venue: "PHX" });
   * const account = client.account(found);
   *
   * const state = await account.freshState();
   * const order = await account.place({ ... });
   * await order.wait();
   * ```
   *
   * This is a view, not a fetch: it performs no request and does not verify
   * that the account exists. The resource form remains available for code that
   * works across several accounts at once.
   */
  account(account: Account): AccountHandle;
  account(venue: Venue, nativeAccount: string): AccountHandle;
  account(venueOrAccount: Venue | Account, nativeAccount?: string): AccountHandle {
    if (typeof venueOrAccount === "string") {
      if (!nativeAccount) {
        throw new PerpUsageError("account(venue, nativeAccount) requires a native account");
      }
      return new AccountHandle(this, venueOrAccount, nativeAccount);
    }
    return new AccountHandle(this, venueOrAccount.venue, venueOrAccount.native_account);
  }

  /** Every owned account on a venue, each already bound to a handle. */
  async accountHandles(
    options: { venue?: Venue; signal?: AbortSignal } = {},
  ): Promise<AccountHandle[]> {
    const accounts = await this.accounts.list(options);
    return accounts.map((account) => this.account(account));
  }

  /** Forces authentication now rather than on the first authenticated call. */
  async login(): Promise<void> {
    await this.session.token();
  }

  /** Drops the cached token. The next call re-authenticates. */
  logout(): Promise<void> {
    return this.session.logout();
  }

  /**
   * A snapshot fresh enough for a `reduce` or `protection` command.
   *
   * Those commands are rejected against a stale fingerprint, so this retries
   * past a stale fallback instead of letting one reach the venue.
   */
  async freshState(
    venue: Venue,
    nativeAccount: string,
    options: { attempts?: number; signal?: AbortSignal } = {},
  ): Promise<AccountSnapshot> {
    const attempts = options.attempts ?? 3;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const { state } = await this.accounts.get(venue, nativeAccount, options.signal);
      if (state && !state.stale) return state;
      if (attempt < attempts - 1) {
        const wait = (state?.retry_after_seconds ?? 1) * 1000;
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
    throw new PerpUsageError(
      `could not obtain a fresh snapshot for ${venue}/${nativeAccount} after ${attempts} attempts`,
    );
  }

  /**
   * Mints a realtime connection token and channel.
   *
   * Exposed here so `@tigertrade/perp-sdk/realtime` can refresh it on every
   * reconnect without a second client.
   */
  realtimeToken(signal?: AbortSignal): Promise<{ token: string; channel: string }> {
    return this.#http.request<{ token: string; channel: string }>({
      method: "POST",
      host: "ledger",
      path: `${API_PREFIX}/realtime/token`,
      kind: "write",
      idempotent: true,
      signal,
    });
  }
}

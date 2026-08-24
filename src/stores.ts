import type { RequestId } from "./types.js";

/* ------------------------------------------------------------- token store */

export interface StoredToken {
  accessToken: string;
  /** RFC 3339 expiry reported by the API. */
  expiresAt: string;
}

/**
 * Where a wallet access token lives between requests.
 *
 * The default keeps tokens in memory only. Do not persist a token to
 * `localStorage`: anything that can run script on the page can read it, and the
 * API has no token revocation.
 */
export interface TokenStore {
  load(owner: string): Promise<StoredToken | undefined>;
  save(owner: string, token: StoredToken): Promise<void>;
  clear(owner: string): Promise<void>;
}

export class MemoryTokenStore implements TokenStore {
  readonly #tokens = new Map<string, StoredToken>();

  async load(owner: string): Promise<StoredToken | undefined> {
    return this.#tokens.get(owner);
  }

  async save(owner: string, token: StoredToken): Promise<void> {
    this.#tokens.set(owner, token);
  }

  async clear(owner: string): Promise<void> {
    this.#tokens.delete(owner);
  }
}

/* ------------------------------------------------------- idempotency store */

/**
 * Remembers the `request_id` chosen for a trading intent.
 *
 * This only earns its keep if it outlives the process. After a crash between
 * "sent the order" and "recorded the response", a durable store lets the client
 * resume polling the original command; without one, the safe move is a full
 * reconciliation through `commands.list({ terminal: false })`.
 */
export interface IdempotencyStore {
  /** Returns the ID already reserved for `key`, if any. */
  get(key: string): Promise<RequestId | undefined>;
  /** Records the ID chosen for `key`. */
  set(key: string, requestId: RequestId): Promise<void>;
  /** Forgets `key` once its command reached a terminal state. */
  delete(key: string): Promise<void>;
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  readonly #ids = new Map<string, RequestId>();

  async get(key: string): Promise<RequestId | undefined> {
    return this.#ids.get(key);
  }

  async set(key: string, requestId: RequestId): Promise<void> {
    this.#ids.set(key, requestId);
  }

  async delete(key: string): Promise<void> {
    this.#ids.delete(key);
  }
}

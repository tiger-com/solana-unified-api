import bs58 from "bs58";

import { PerpAuthError } from "./errors.js";
import type { HttpClient } from "./http.js";
import { API_PREFIX } from "./config.js";
import { ownerPubkey, type PerpSigner } from "./signer.js";
import { MemoryTokenStore, type StoredToken, type TokenStore } from "./stores.js";
import type { AccessToken, WalletChallenge } from "./types.js";

export interface SessionOptions {
  signer: PerpSigner;
  tokenStore?: TokenStore;
  /**
   * Renew this many milliseconds before `expires_at`.
   *
   * There is no refresh token, so renewal means another wallet signature. The
   * margin exists so that happens between trades rather than during one.
   */
  renewBeforeMs?: number;
  /**
   * Called before the SDK asks the wallet to sign a login challenge.
   *
   * In a browser this is a visible wallet prompt. Return `false` to refuse —
   * the pending request then fails with `PerpAuthError` instead of surprising
   * the user with a popup.
   */
  onAuthRequired?: (context: { owner: string; reason: "missing" | "expired" | "rejected" }) =>
    | boolean
    | Promise<boolean>;
}

/**
 * Owns the wallet access token: obtains it, caches it, and renews it.
 *
 * Renewal is single-flight. Ten concurrent requests hitting an expired token
 * produce one wallet prompt, not ten.
 */
export class WalletSession {
  readonly #http: HttpClient;
  readonly #signer: PerpSigner;
  readonly #store: TokenStore;
  readonly #renewBeforeMs: number;
  readonly #onAuthRequired: SessionOptions["onAuthRequired"];
  readonly owner: string;

  #inFlight: Promise<StoredToken> | null = null;

  constructor(http: HttpClient, options: SessionOptions) {
    this.#http = http;
    this.#signer = options.signer;
    this.#store = options.tokenStore ?? new MemoryTokenStore();
    this.#renewBeforeMs = options.renewBeforeMs ?? 60_000;
    this.#onAuthRequired = options.onAuthRequired;
    this.owner = ownerPubkey(options.signer);
  }

  /** A valid bearer token, logging in or renewing if necessary. */
  async token(): Promise<string> {
    const cached = await this.#store.load(this.owner);
    if (cached && !this.#isExpiring(cached)) return cached.accessToken;
    const fresh = await this.#authenticate(cached ? "expired" : "missing");
    return fresh.accessToken;
  }

  /** Current token without triggering a login. Used by the transport. */
  async peek(): Promise<string | undefined> {
    const cached = await this.#store.load(this.owner);
    if (cached && !this.#isExpiring(cached)) return cached.accessToken;
    try {
      return await this.token();
    } catch {
      // Let the request go out unauthenticated; the 401 path handles it.
      return undefined;
    }
  }

  /** Drops the cached token and logs in again. Returns false if refused. */
  async reauthenticate(): Promise<boolean> {
    await this.#store.clear(this.owner);
    try {
      await this.#authenticate("rejected");
      return true;
    } catch {
      return false;
    }
  }

  async logout(): Promise<void> {
    await this.#store.clear(this.owner);
  }

  #isExpiring(token: StoredToken): boolean {
    const expiry = Date.parse(token.expiresAt);
    if (Number.isNaN(expiry)) return true;
    return expiry - this.#renewBeforeMs <= Date.now();
  }

  #authenticate(reason: "missing" | "expired" | "rejected"): Promise<StoredToken> {
    // Single-flight: concurrent callers share one wallet prompt.
    this.#inFlight ??= this.#login(reason).finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async #login(reason: "missing" | "expired" | "rejected"): Promise<StoredToken> {
    if (this.#onAuthRequired) {
      const approved = await this.#onAuthRequired({ owner: this.owner, reason });
      if (!approved) {
        throw new PerpAuthError(`wallet authentication declined (${reason})`);
      }
    }

    const challenge = await this.#http.request<WalletChallenge>({
      method: "POST",
      path: `${API_PREFIX}/wallet/challenges`,
      body: { owner_pubkey: this.owner },
      auth: false,
      kind: "write",
      idempotent: true,
    });

    // Sign the exact bytes the API returned. Any normalisation invalidates it.
    const signature = await this.#signer.signMessage(
      new TextEncoder().encode(challenge.message),
    );

    const issued = await this.#http.request<AccessToken>({
      method: "POST",
      path: `${API_PREFIX}/wallet/challenges/verify`,
      body: {
        owner_pubkey: this.owner,
        challenge_token: challenge.challenge_token,
        signature: bs58.encode(signature),
      },
      auth: false,
      kind: "write",
      // A challenge is single-use; a blind replay would fail as a mismatch.
      idempotent: false,
    });

    const token: StoredToken = {
      accessToken: issued.access_token,
      expiresAt: issued.expires_at,
    };
    await this.#store.save(this.owner, token);
    return token;
  }
}

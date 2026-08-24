import { API_PREFIX } from "../config.js";
import type { HttpClient } from "../http.js";
import type {
  Account,
  AccountSetup,
  AccountWithState,
  LifecycleResult,
  Venue,
} from "../types.js";

const accountPath = (venue: Venue, nativeAccount: string): string =>
  `${API_PREFIX}/venues/${encodeURIComponent(venue)}/accounts/${encodeURIComponent(nativeAccount)}`;

/** Account lifecycle: creation, owner-signed setup, pause, resume, revocation. */
export class AccountsResource {
  constructor(private readonly http: HttpClient) {}

  /** Every account owned by the authenticated wallet, in every status. */
  async list(options: { venue?: Venue; signal?: AbortSignal } = {}): Promise<Account[]> {
    const body = await this.http.request<{ accounts: Account[] }>({
      method: "GET",
      path: `${API_PREFIX}/accounts`,
      query: { venue: options.venue },
      idempotent: true,
      signal: options.signal,
    });
    return body.accounts;
  }

  /**
   * Creates, resumes, or reconnects the venue's default managed account.
   *
   * The response carries the next required onboarding step; drive it with
   * `continueSetup` and `confirmSetup`, or let
   * `@tigertrade/perp-sdk/solana` run the whole sequence.
   *
   * Supplying a name for an existing account does not rename it.
   */
  create(
    venue: Venue,
    options: { name?: string; signal?: AbortSignal } = {},
  ): Promise<AccountSetup> {
    return this.http.request<AccountSetup>({
      method: "POST",
      path: `${API_PREFIX}/venues/${encodeURIComponent(venue)}/accounts`,
      // `{}` is valid; an empty HTTP body is not.
      body: options.name === undefined ? {} : { name: options.name },
      // Convergent: concurrent calls settle on one durable account.
      idempotent: true,
      signal: options.signal,
    });
  }

  /**
   * Account identity, plus live `state` for ACTIVE and PAUSED accounts.
   *
   * A `state.stale` snapshot is a fallback projection: still HTTP 200, but not
   * usable for a command fingerprint. Retry after `state.retry_after_seconds`.
   */
  get(venue: Venue, nativeAccount: string, signal?: AbortSignal): Promise<AccountWithState> {
    return this.http.request<AccountWithState>({
      method: "GET",
      path: accountPath(venue, nativeAccount),
      idempotent: true,
      signal,
    });
  }

  /**
   * Submits an owner-signed registration wire, or polls a pending registration.
   *
   * Do **not** broadcast a registration transaction yourself: it is incomplete
   * until the venue onboarder co-signs it. Call this with no `step` to poll.
   */
  continueSetup(
    venue: Venue,
    nativeAccount: string,
    step?: { setup_step_id: string; signed_transaction: string },
    signal?: AbortSignal,
  ): Promise<AccountSetup> {
    return this.http.request<AccountSetup>({
      method: "POST",
      path: `${accountPath(venue, nativeAccount)}/setup/continue`,
      body: step,
      // The service stores the signed wire before forwarding it and reuses it.
      idempotent: true,
      signal,
    });
  }

  /**
   * Confirms a finalized delegation transaction.
   *
   * Submit the transaction, wait for `finalized` commitment, then call this.
   * Confirming before finality can leave the account stuck mid-setup.
   */
  confirmSetup(
    venue: Venue,
    nativeAccount: string,
    proof: { setup_step_id: string; signature: string },
    signal?: AbortSignal,
  ): Promise<LifecycleResult> {
    return this.http.request<LifecycleResult>({
      method: "POST",
      path: `${accountPath(venue, nativeAccount)}/setup/confirm`,
      body: proof,
      idempotent: true,
      signal,
    });
  }

  /**
   * Moves an ACTIVE account to PAUSED.
   *
   * Not idempotent: on a conflict, re-read the account instead of retrying.
   */
  disable(venue: Venue, nativeAccount: string, signal?: AbortSignal): Promise<Account> {
    return this.http.request<Account>({
      method: "POST",
      path: `${accountPath(venue, nativeAccount)}/disable`,
      idempotent: false,
      signal,
    });
  }

  /** Re-enables an eligible PAUSED account. Not idempotent. */
  enable(venue: Venue, nativeAccount: string, signal?: AbortSignal): Promise<Account> {
    return this.http.request<Account>({
      method: "POST",
      path: `${accountPath(venue, nativeAccount)}/enable`,
      idempotent: false,
      signal,
    });
  }

  /**
   * Builds owner-signed delegate revocation. Requires PAUSED — call
   * `disable` first.
   */
  revoke(venue: Venue, nativeAccount: string, signal?: AbortSignal): Promise<AccountSetup> {
    return this.http.request<AccountSetup>({
      method: "POST",
      path: `${accountPath(venue, nativeAccount)}/revoke`,
      idempotent: true,
      signal,
    });
  }

  /** Confirms finalized revocation. Idempotent with the same proof. */
  confirmRevocation(
    venue: Venue,
    nativeAccount: string,
    proof: { setup_step_id: string; signature: string },
    signal?: AbortSignal,
  ): Promise<LifecycleResult> {
    return this.http.request<LifecycleResult>({
      method: "POST",
      path: `${accountPath(venue, nativeAccount)}/revoke/confirm`,
      body: proof,
      idempotent: true,
      signal,
    });
  }
}

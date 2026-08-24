import { API_PREFIX } from "../config.js";
import * as decimal from "../decimal.js";
import { PerpUsageError } from "../errors.js";
import type { HttpClient } from "../http.js";
import type { CollateralTransaction, Decimal, Venue } from "../types.js";

const MAX_FRACTION_DIGITS = 6;
const MAX_ATOMIC_UNITS = 2n ** 64n - 1n;

/**
 * The API accepts one positive decimal with at most six fractional digits,
 * whose six-decimal atomic form fits an unsigned 64-bit integer. Checking here
 * turns a `400` round trip into an immediate, specific error.
 */
function assertAmount(amount: Decimal): void {
  if (!decimal.isPositive(amount)) {
    throw new PerpUsageError(`collateral amount must be positive, received ${amount}`);
  }
  const parsed = decimal.parse(amount, "amount");
  if (parsed.scale > MAX_FRACTION_DIGITS) {
    throw new PerpUsageError(
      `collateral amount supports at most ${MAX_FRACTION_DIGITS} fractional digits, received ${amount}`,
    );
  }
  const atomic = parsed.units * 10n ** BigInt(MAX_FRACTION_DIGITS - parsed.scale);
  if (atomic > MAX_ATOMIC_UNITS) {
    throw new PerpUsageError(`collateral amount ${amount} exceeds the u64 atomic range`);
  }
}

/**
 * Owner-signed deposits and withdrawals.
 *
 * These routes build and validate a transaction; they never submit it and never
 * create a command. Sign and submit it yourself — `submitAndConfirm` in
 * `@tigercom/perp-sdk/solana` does that — then observe the result through
 * account state and the ledger. There is no confirm endpoint for collateral.
 */
export class CollateralResource {
  constructor(private readonly http: HttpClient) {}

  async deposit(
    venue: Venue,
    nativeAccount: string,
    amount: Decimal,
    signal?: AbortSignal,
  ): Promise<CollateralTransaction> {
    return this.#build("deposit", venue, nativeAccount, amount, signal);
  }

  /**
   * Builds a withdrawal. Bounded by `state.balances[].available_withdraw` and
   * by venue risk checks at execution time.
   */
  async withdraw(
    venue: Venue,
    nativeAccount: string,
    amount: Decimal,
    signal?: AbortSignal,
  ): Promise<CollateralTransaction> {
    return this.#build("withdraw", venue, nativeAccount, amount, signal);
  }

  async #build(
    operation: "deposit" | "withdraw",
    venue: Venue,
    nativeAccount: string,
    amount: Decimal,
    signal?: AbortSignal,
  ): Promise<CollateralTransaction> {
    assertAmount(amount);
    return this.http.request<CollateralTransaction>({
      method: "POST",
      path:
        `${API_PREFIX}/venues/${encodeURIComponent(venue)}` +
        `/accounts/${encodeURIComponent(nativeAccount)}/collateral/${operation}`,
      body: { amount },
      // Building a transaction has no on-chain effect until it is submitted.
      idempotent: true,
      signal,
    });
  }
}

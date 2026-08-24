/**
 * `@tigercom/perp-sdk` — TypeScript client for the Tiger Solana unified
 * perpetuals API.
 *
 * The core entry point runs unchanged in Node and in the browser. Environment
 * helpers live in the subpath entries:
 *
 * - `@tigercom/perp-sdk/browser` — wallet-adapter signer
 * - `@tigercom/perp-sdk/node` — keypair signer
 * - `@tigercom/perp-sdk/solana` — submit and confirm transactions
 * - `@tigercom/perp-sdk/realtime` — live execution and position events
 */
export { PerpClient, type PerpClientOptions } from "./client.js";
export { AccountHandle, type SubmittedCommand } from "./account-handle.js";
export {
  ENVIRONMENTS,
  API_PREFIX,
  resolveEndpoints,
  type Endpoints,
  type EnvironmentName,
} from "./config.js";

export {
  PerpError,
  PerpApiError,
  PerpCommandError,
  PerpAuthError,
  PerpTransportError,
  PerpUsageError,
  isApiError,
  isCommandError,
  hasErrorCode,
  type ErrorCode,
} from "./errors.js";

export { WalletSession, type SessionOptions } from "./session.js";
export {
  ownerPubkey,
  canSignTransactions,
  type PerpSigner,
  type PerpTransactionSigner,
  type WalletPublicKey,
} from "./signer.js";

export {
  MemoryTokenStore,
  MemoryIdempotencyStore,
  type TokenStore,
  type StoredToken,
  type IdempotencyStore,
} from "./stores.js";

export { newRequestId, assertRequestId } from "./idempotency.js";
export { alignPrice, alignQuantity, validateOrder, indexMarkets, type OrderDraft } from "./market.js";
export * as decimal from "./decimal.js";

export type { RetryPolicy, Host } from "./http.js";
export type { IntentOptions } from "./resources/trading.js";
export type { CommandListOptions, WaitOptions } from "./resources/commands.js";
export type { PageOptions } from "./resources/history.js";

export * from "./types.js";

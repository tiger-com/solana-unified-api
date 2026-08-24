import type { ApiErrorBody } from "./types.js";

/**
 * Error codes the API can return. `code` is the stable contract — branch on it,
 * never on `message`.
 */
export type ErrorCode =
  | "invalid_request"
  | "challenge_expired"
  | "challenge_mismatch"
  | "unauthorized"
  | "invalid_wallet_signature"
  | "forbidden"
  | "account_not_found"
  | "conflict"
  | "stale_state"
  | "delegate_credentials_invalid"
  | "phoenix_authority_mismatch"
  | "account_ownership_conflict"
  | "lifecycle_conflict"
  | "phoenix_registration_required"
  | "gateway_conflict"
  | "not_supported"
  | "venue_rejected"
  | "user_rate_limited"
  | "history_capacity_exceeded"
  | "market_data_rate_limited"
  | "solana_rpc_rate_limited"
  | "venue_provider_rate_limited"
  | "submission_unknown"
  | "gateway_protocol_error"
  | "transaction_not_submitted"
  | "dependency_unavailable"
  | "venue_data_unavailable"
  | "transaction_status_unavailable"
  | "delegate_credentials_unavailable"
  | "venue_gateway_unavailable"
  | "venue_unsupported"
  | "system_error"
  // Present on the SDK surface but not returned by the API itself.
  | (string & {});

/**
 * Default retry delays, in seconds, keyed by error code.
 *
 * The API sends `retry_after_seconds` and a `Retry-After` header on retryable
 * responses; these are the documented fallbacks when neither arrives.
 */
const DEFAULT_RETRY_SECONDS: Record<string, number> = {
  dependency_unavailable: 1,
  delegate_credentials_unavailable: 1,
  history_capacity_exceeded: 1,
  market_data_rate_limited: 1,
  solana_rpc_rate_limited: 1,
  transaction_status_unavailable: 1,
  user_rate_limited: 1,
  venue_data_unavailable: 1,
  venue_gateway_unavailable: 1,
  venue_provider_rate_limited: 2,
};

/** Base class for every error the SDK throws. */
export class PerpError extends Error {
  override readonly name: string = "PerpError";
}

/** An error envelope returned by the API. */
export class PerpApiError extends PerpError {
  override readonly name: string = "PerpApiError";

  readonly status: number;
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | undefined;
  /** Request path, useful when an error surfaces far from its call site. */
  readonly path: string;

  constructor(init: {
    status: number;
    body: ApiErrorBody;
    path: string;
    retryAfterHeader?: number | undefined;
  }) {
    super(init.body.message || init.body.code);
    this.status = init.status;
    this.code = init.body.code;
    this.retryable = init.body.retryable === true;
    this.path = init.path;
    this.retryAfterSeconds =
      init.body.retry_after_seconds ??
      init.retryAfterHeader ??
      DEFAULT_RETRY_SECONDS[init.body.code];
  }

  /** Whether this error is worth another attempt of the same request. */
  get isRetryable(): boolean {
    return this.retryable || this.retryAfterSeconds !== undefined;
  }
}

/**
 * A trading command was admitted and stored, but the call still failed.
 *
 * The command is durable. Poll it with the same `request_id` until it reaches a
 * terminal state — issuing a replacement intent is how an integration
 * double-fills. `client.commands.waitForTerminal(...)` does the polling.
 */
export class PerpCommandError extends PerpApiError {
  override readonly name: string = "PerpCommandError";

  /** The stored command carried by the error response. */
  readonly command: import("./types.js").Command;

  constructor(init: {
    status: number;
    body: ApiErrorBody;
    path: string;
    retryAfterHeader?: number | undefined;
    command: import("./types.js").Command;
  }) {
    super(init);
    this.command = init.command;
  }
}

/** The wallet session is missing or expired and could not be renewed. */
export class PerpAuthError extends PerpError {
  override readonly name: string = "PerpAuthError";
}

/** The request never produced a response — network failure, abort, or timeout. */
export class PerpTransportError extends PerpError {
  override readonly name: string = "PerpTransportError";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** A precondition the SDK checks before spending a request. */
export class PerpUsageError extends PerpError {
  override readonly name: string = "PerpUsageError";
}

export const isApiError = (error: unknown): error is PerpApiError =>
  error instanceof PerpApiError;

export const isCommandError = (error: unknown): error is PerpCommandError =>
  error instanceof PerpCommandError;

/** True when `error` is an API error carrying one of `codes`. */
export const hasErrorCode = (error: unknown, ...codes: ErrorCode[]): boolean =>
  isApiError(error) && codes.includes(error.code);

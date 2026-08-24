import { API_PREFIX } from "../config.js";
import { PerpUsageError } from "../errors.js";
import type { HttpClient } from "../http.js";
import { assertRequestId, newRequestId } from "../idempotency.js";
import { validateOrder } from "../market.js";
import type { IdempotencyStore } from "../stores.js";
import type {
  CancelOrdersRequest,
  CommandEnvelope,
  Market,
  OrderPurpose,
  OrdersPage,
  PlaceOrderRequest,
  ReducePositionRequest,
  RequestId,
  SetProtectionRequest,
  Venue,
  WithoutRequestId,
} from "../types.js";

export interface IntentOptions {
  /**
   * Reuse an existing idempotency key.
   *
   * Pass this when resending an intent you already created — after a timeout,
   * a lost response, or a restart. A fresh key on a live command is how an
   * integration double-fills.
   */
  requestId?: RequestId;
  /**
   * A stable application-level name for this intent, e.g. `"rebalance-2026-08-24"`.
   *
   * The SDK resolves it through the configured `IdempotencyStore`, so the same
   * key always maps to the same `request_id` — including across restarts, if
   * the store is durable.
   */
  intentKey?: string;
  /** Validate the draft against this market before spending a request. */
  market?: Market;
  signal?: AbortSignal;
}

const accountPath = (venue: Venue, nativeAccount: string): string =>
  `${API_PREFIX}/venues/${encodeURIComponent(venue)}/accounts/${encodeURIComponent(nativeAccount)}`;

/**
 * Rejects order shapes the API will reject anyway.
 *
 * Catching these locally keeps a malformed order from consuming a rate-limit
 * token and returning an opaque `400`.
 */
function assertOrderShape(order: WithoutRequestId<PlaceOrderRequest>): void {
  const { kind, execution_mode: mode } = order;

  if (kind === "MARKET") {
    if (mode !== "IOC") throw new PerpUsageError("MARKET orders require execution_mode IOC");
    if (order.limit_price !== undefined) {
      throw new PerpUsageError("MARKET orders must omit limit_price");
    }
  }
  if (kind === "LIMIT" && order.limit_price === undefined) {
    throw new PerpUsageError("LIMIT orders require a positive limit_price");
  }
  if (kind === "CONDITIONAL") {
    if (mode !== "GTC") {
      throw new PerpUsageError("CONDITIONAL stop-market entries require execution_mode GTC");
    }
    if (order.trigger_price === undefined) {
      throw new PerpUsageError("CONDITIONAL orders require a positive trigger_price");
    }
    for (const field of ["limit_price", "post_only", "max_slippage_bps"] as const) {
      if (order[field] !== undefined) {
        throw new PerpUsageError(`stop-market orders must omit ${field}`);
      }
    }
  }
  if (order.post_only && !(kind === "LIMIT" && mode === "GTC")) {
    throw new PerpUsageError("post_only is allowed only for LIMIT orders with GTC");
  }
}

/**
 * Durable, idempotent trading commands.
 *
 * Every method admits an intent and returns the stored command. A `202` means
 * the intent is durable, not that it executed — follow it with
 * `client.commands.waitForTerminal(...)`.
 */
export class TradingResource {
  constructor(
    private readonly http: HttpClient,
    private readonly idempotency: IdempotencyStore,
  ) {}

  /**
   * Current venue orders plus the snapshot they were read from.
   *
   * Requires ACTIVE or PAUSED; PENDING and REVOKED return `409 stale_state`.
   */
  orders(
    venue: Venue,
    nativeAccount: string,
    options: { marketId?: string; purpose?: OrderPurpose; signal?: AbortSignal } = {},
  ): Promise<OrdersPage> {
    return this.http.request<OrdersPage>({
      method: "GET",
      path: `${accountPath(venue, nativeAccount)}/orders`,
      query: { market_id: options.marketId, purpose: options.purpose },
      idempotent: true,
      signal: options.signal,
    });
  }

  /** Places one order through the managed delegate. The client does not sign it. */
  async place(
    venue: Venue,
    nativeAccount: string,
    order: WithoutRequestId<PlaceOrderRequest>,
    options: IntentOptions = {},
  ): Promise<CommandEnvelope> {
    assertOrderShape(order);
    if (options.market) {
      validateOrder(options.market, {
        quantity: order.quantity,
        price: order.limit_price ?? order.trigger_price,
        kind: order.kind,
      });
    }
    return this.#submit(`${accountPath(venue, nativeAccount)}/orders`, order, options);
  }

  /**
   * Cancels selected orders, or every order in one market.
   *
   * Exactly one of `venue_order_ids` and `cancel_all` is required. Cancellation
   * stays available while an account is PAUSED.
   */
  async cancel(
    venue: Venue,
    nativeAccount: string,
    request: WithoutRequestId<CancelOrdersRequest>,
    options: IntentOptions = {},
  ): Promise<CommandEnvelope> {
    const hasIds = request.venue_order_ids !== undefined;
    if (hasIds === (request.cancel_all === true)) {
      throw new PerpUsageError("pass exactly one of venue_order_ids or cancel_all: true");
    }
    if (request.venue_order_ids) {
      const unique = new Set(request.venue_order_ids);
      if (unique.size !== request.venue_order_ids.length) {
        throw new PerpUsageError("venue_order_ids must be unique");
      }
      if (unique.size === 0 || unique.size > 30) {
        throw new PerpUsageError("venue_order_ids must hold 1–30 values");
      }
    }
    return this.#submit(`${accountPath(venue, nativeAccount)}/orders/cancel`, request, options);
  }

  /**
   * Reduces the current position in one market.
   *
   * `expected_snapshot_fingerprint` must come from a fresh (`stale: false`)
   * snapshot. A superseded fingerprint returns `409 stale_state`: re-read state
   * and submit a **new** intent, since the old one was never admitted.
   */
  async reduce(
    venue: Venue,
    nativeAccount: string,
    marketId: string,
    request: WithoutRequestId<ReducePositionRequest>,
    options: IntentOptions = {},
  ): Promise<CommandEnvelope> {
    return this.#submit(
      `${accountPath(venue, nativeAccount)}/positions/${encodeURIComponent(marketId)}/reduce`,
      request,
      options,
    );
  }

  /**
   * Sets native take-profit and stop-loss for the current position.
   *
   * Requires `capabilities.positions.protection` and a fresh snapshot
   * fingerprint.
   */
  async setProtection(
    venue: Venue,
    nativeAccount: string,
    marketId: string,
    request: WithoutRequestId<SetProtectionRequest>,
    options: IntentOptions = {},
  ): Promise<CommandEnvelope> {
    if (request.take_profit_price === undefined && request.stop_loss_price === undefined) {
      throw new PerpUsageError("pass at least one of take_profit_price or stop_loss_price");
    }
    if (request.stop_loss_slippage_bps !== undefined && request.stop_loss_price === undefined) {
      throw new PerpUsageError("stop_loss_slippage_bps requires stop_loss_price");
    }
    return this.#submit(
      `${accountPath(venue, nativeAccount)}/positions/${encodeURIComponent(marketId)}/protection`,
      request,
      options,
    );
  }

  /** Resolves the idempotency key for an intent, then posts it. */
  async #submit(
    path: string,
    body: Record<string, unknown>,
    options: IntentOptions,
  ): Promise<CommandEnvelope> {
    const requestId = await this.#resolveRequestId(options);
    return this.http.request<CommandEnvelope>({
      method: "POST",
      path,
      body: { ...body, request_id: requestId },
      // Safe to replay: the API returns the stored command for a repeated
      // request_id and rejects a changed body with 409 rather than acting twice.
      idempotent: true,
      signal: options.signal,
    });
  }

  async #resolveRequestId(options: IntentOptions): Promise<RequestId> {
    if (options.requestId) return assertRequestId(options.requestId);

    if (options.intentKey) {
      const existing = await this.idempotency.get(options.intentKey);
      if (existing) return existing;
      const created = newRequestId();
      await this.idempotency.set(options.intentKey, created);
      return created;
    }
    return newRequestId();
  }
}

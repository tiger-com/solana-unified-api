/**
 * Public type surface.
 *
 * Every shape is aliased from `src/generated/openapi.ts`, which is regenerated
 * from `spec/openapi.yaml` by `npm run generate`. Editing the spec and
 * regenerating is the only supported way to change these types.
 */
import type { components } from "./generated/openapi.js";

type Schemas = components["schemas"];

/* ------------------------------------------------------------------ scalars */

/**
 * Exact decimal value carried as a string.
 *
 * Never parse one into a JS `number`: `0.1 + 0.2` is not `0.3`, and a rounded
 * quantity is a rejected or wrongly sized order. Use the helpers in
 * `align.ts`, or a decimal library, and hand the API a string back.
 */
export type Decimal = string;

/** Canonical base58 Solana public key. */
export type Pubkey = string;

/** Canonical lowercase UUID used as a trading idempotency key. */
export type RequestId = string;

/** RFC 3339 timestamp. */
export type Timestamp = string;

/** Venue code, e.g. `PHX`. Discover the live set with `client.venues.list()`. */
export type Venue = Schemas["Venue"];

/* ------------------------------------------------------------- discovery */

export type VenueDescriptor = Schemas["VenueDescriptor"];
export type VenueCapabilities = Schemas["VenueCapabilities"];
export type OrderCapabilities = Schemas["OrderCapabilities"];
export type PositionCapabilities = Schemas["PositionCapabilities"];
export type Market = Schemas["Market"];
export type MarketData = Schemas["MarketData"];
export type OrderBook = Schemas["OrderBook"];
export type OrderBookLevel = Schemas["OrderBookLevel"];
export type MarketTrade = Schemas["MarketTrade"];
export type MarketTradesPage = Schemas["MarketTradesPage"];

/* -------------------------------------------------------------------- auth */

export type WalletChallenge = Schemas["WalletChallenge"];
export type AccessToken = Schemas["AccessToken"];
export type Jwks = Schemas["Jwks"];

/* ---------------------------------------------------------------- accounts */

export type Account = Schemas["Account"];
export type AccountStatus = Schemas["AccountStatus"];
export type AccountSetup = Schemas["AccountSetup"];
export type SetupPhase = Schemas["SetupPhase"];
export type LifecycleResult = Schemas["LifecycleResult"];
export type AccountSnapshot = Schemas["AccountSnapshot"];
export type SnapshotMeta = Schemas["SnapshotMeta"];
export type Balance = Schemas["Balance"];
export type Position = Schemas["Position"];

/** `GET /venues/{venue}/accounts/{native_account}`. `state` is absent for PENDING and REVOKED. */
export interface AccountWithState {
  account: Account;
  state?: AccountSnapshot;
}

/* -------------------------------------------------------------- collateral */

export type CollateralTransaction = Schemas["CollateralTransaction"];

/* ----------------------------------------------------------------- trading */

export type Order = Schemas["Order"];
export type OrderKind = Schemas["OrderKind"];
export type OrderPurpose = Schemas["OrderPurpose"];
export type ExecutionMode = Schemas["ExecutionMode"];
export type Side = Schemas["Side"];

export type PlaceOrderRequest = Schemas["PlaceOrderRequest"];
export type CancelOrdersRequest = Schemas["CancelOrdersRequest"];
export type ReducePositionRequest = Schemas["ReducePositionRequest"];
export type SetProtectionRequest = Schemas["SetProtectionRequest"];

export type Command = Schemas["Command"];
export type CommandState = Schemas["CommandState"];
export type CommandEnvelope = Schemas["CommandEnvelope"];

/** `GET .../orders` returns the orders together with the snapshot they were read from. */
export interface OrdersPage {
  orders: Order[];
  snapshot: SnapshotMeta;
}

/**
 * A trading request with `request_id` removed.
 *
 * Resource methods accept this shape and attach the idempotency key themselves,
 * so an application cannot accidentally reuse one key for two different intents.
 */
export type WithoutRequestId<T> = Omit<T, "request_id">;

/* ----------------------------------------------------------------- history */

export type Fill = Schemas["Fill"];
export type LedgerFill = Schemas["LedgerFill"];
export type LedgerEvent = Schemas["LedgerEvent"];
export type LedgerPage = Schemas["LedgerPage"];
export type HistoryPageMeta = Schemas["HistoryPageMeta"];

export type FillsPage = HistoryPageMeta & { fills: Fill[] };

export type CommandsPage = {
  commands: Command[];
  has_more: boolean;
  next_cursor: string;
};

/* ---------------------------------------------------------------- realtime */

export type ExecutionEvent = Schemas["ExecutionEvent"];
export type PositionEvent = Schemas["PositionEvent"];
export type EventMarket = Schemas["EventMarket"];
export type PositionAfter = Schemas["PositionAfter"];

/* ------------------------------------------------------------------ errors */

export type ApiErrorBody = Schemas["Error"];

/** Command states that will never change again. */
export const TERMINAL_COMMAND_STATES = [
  "CONFIRMED",
  "COMPLETED",
  "FAILED",
  "EXPIRED",
] as const satisfies readonly CommandState[];

export const isTerminalCommandState = (state: CommandState): boolean =>
  (TERMINAL_COMMAND_STATES as readonly string[]).includes(state);

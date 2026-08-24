import * as decimal from "./decimal.js";
import { PerpUsageError } from "./errors.js";
import type { Decimal, Market, OrderKind } from "./types.js";

/** Snaps a quantity to the market's `quantity_step`. Rounds toward zero by default. */
export const alignQuantity = (
  market: Market,
  quantity: Decimal,
  mode: decimal.RoundingMode = "down",
): Decimal => decimal.roundToMultiple(quantity, market.quantity_step, mode);

/** Snaps a price to the market's `price_tick`. */
export const alignPrice = (
  market: Market,
  price: Decimal,
  mode: decimal.RoundingMode = "nearest",
): Decimal => decimal.roundToMultiple(price, market.price_tick, mode);

export interface OrderDraft {
  quantity: Decimal;
  price?: Decimal | undefined;
  kind?: OrderKind | undefined;
}

/**
 * Checks an order against the market's published limits before it costs a
 * request and a rate-limit token.
 *
 * This covers only what the catalog publishes. Venue risk checks still run at
 * execution time, so a draft that passes here can still be rejected on chain.
 * An omitted `minimum_notional` or `max_market_quantity` means the venue
 * publishes no fixed limit — it is not zero, and must not be inferred.
 */
export function validateOrder(market: Market, draft: OrderDraft): void {
  const fail = (message: string): never => {
    throw new PerpUsageError(`${market.symbol}: ${message}`);
  };

  if (!market.trading_supported) fail("trading is not currently supported");

  if (!decimal.isPositive(draft.quantity)) fail("quantity must be positive");

  if (decimal.compare(alignQuantity(market, draft.quantity), draft.quantity) !== 0) {
    fail(`quantity ${draft.quantity} is not a multiple of quantity_step ${market.quantity_step}`);
  }
  if (decimal.compare(draft.quantity, market.minimum_quantity) < 0) {
    fail(`quantity ${draft.quantity} is below minimum_quantity ${market.minimum_quantity}`);
  }
  if (
    draft.kind === "MARKET" &&
    market.max_market_quantity !== undefined &&
    decimal.compare(draft.quantity, market.max_market_quantity) > 0
  ) {
    fail(
      `quantity ${draft.quantity} exceeds max_market_quantity ${market.max_market_quantity}`,
    );
  }

  if (draft.price !== undefined) {
    if (!decimal.isPositive(draft.price)) fail("price must be positive");
    if (decimal.compare(alignPrice(market, draft.price, "down"), draft.price) !== 0) {
      fail(`price ${draft.price} is not a multiple of price_tick ${market.price_tick}`);
    }
    if (market.minimum_notional !== undefined) {
      const notional = decimal.multiply(draft.quantity, draft.price);
      if (decimal.compare(notional, market.minimum_notional) < 0) {
        fail(`notional ${notional} is below minimum_notional ${market.minimum_notional}`);
      }
    }
  }
}

/** Index a market catalog by `market_id` for repeated lookups. */
export const indexMarkets = (markets: Market[]): Map<string, Market> =>
  new Map(markets.map((market) => [market.market_id, market]));

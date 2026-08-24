import { API_PREFIX } from "../config.js";
import type { HttpClient } from "../http.js";
import { indexMarkets } from "../market.js";
import type {
  Market,
  MarketTrade,
  MarketTradesPage,
  OrderBook,
  Venue,
  VenueDescriptor,
} from "../types.js";

/** Unauthenticated reads describing what the environment currently supports. */
export class DiscoveryResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Enabled venues and their capabilities.
   *
   * Capabilities are runtime data. Gate optional order shapes on these flags
   * rather than on the venue code — `stop_market`, for one, differs between
   * venues and between environments.
   */
  async venues(signal?: AbortSignal): Promise<VenueDescriptor[]> {
    const body = await this.http.request<{ venues: VenueDescriptor[] }>({
      method: "GET",
      path: `${API_PREFIX}/venues`,
      auth: false,
      idempotent: true,
      signal,
    });
    return body.venues;
  }

  /** One venue descriptor, or `undefined` when the environment does not enable it. */
  async venue(venue: Venue, signal?: AbortSignal): Promise<VenueDescriptor | undefined> {
    const venues = await this.venues(signal);
    return venues.find((descriptor) => descriptor.venue === venue);
  }

  /**
   * The market catalog for one venue. Cached by the API for 60 seconds.
   *
   * Retain the returned `market_id` values; never hardcode them.
   */
  async markets(venue: Venue, signal?: AbortSignal): Promise<Market[]> {
    const body = await this.http.request<{ markets: Market[] }>({
      method: "GET",
      path: `${API_PREFIX}/markets`,
      query: { venue },
      auth: false,
      idempotent: true,
      signal,
    });
    return body.markets;
  }

  /** One market including live `market_data`. Cached by the API for one second. */
  async market(venue: Venue, marketId: string, signal?: AbortSignal): Promise<Market | undefined> {
    const body = await this.http.request<{ markets: Market[] }>({
      method: "GET",
      path: `${API_PREFIX}/markets`,
      query: { venue, market_id: marketId },
      auth: false,
      idempotent: true,
      signal,
    });
    return body.markets[0];
  }

  /** The catalog indexed by `market_id`, for repeated lookups. */
  async marketIndex(venue: Venue, signal?: AbortSignal): Promise<Map<string, Market>> {
    return indexMarkets(await this.markets(venue, signal));
  }

  /**
   * Aggregated resting liquidity for one market, best price first.
   *
   * Public and cached for one second. `updated_slot` repeats until the venue publishes a
   * newer book, so compare it before recomputing anything expensive.
   *
   * Levels are aggregated by price and carry no identity: this cannot tell you which size
   * is yours. Read your own orders with `client.trading.orders(...)`.
   *
   * Requires `capabilities.orderbook`.
   */
  orderbook(
    venue: Venue,
    marketId: string,
    options: { depth?: number; signal?: AbortSignal } = {},
  ): Promise<OrderBook> {
    return this.http.request<OrderBook>({
      method: "GET",
      path:
        `${API_PREFIX}/venues/${encodeURIComponent(venue)}` +
        `/markets/${encodeURIComponent(marketId)}/orderbook`,
      query: { depth: options.depth },
      auth: false,
      idempotent: true,
      signal: options.signal,
    });
  }

  /**
   * Recent public trades for one market, newest first.
   *
   * This is the whole market's tape with no account attribution. Your own executions live
   * in `client.history.fills(...)` and the ledger.
   *
   * Requires `capabilities.market_trades`.
   */
  trades(
    venue: Venue,
    marketId: string,
    options: { limit?: number; cursor?: string; signal?: AbortSignal } = {},
  ): Promise<MarketTradesPage> {
    return this.http.request<MarketTradesPage>({
      method: "GET",
      path:
        `${API_PREFIX}/venues/${encodeURIComponent(venue)}` +
        `/markets/${encodeURIComponent(marketId)}/trades`,
      query: { limit: options.limit, cursor: options.cursor },
      auth: false,
      idempotent: true,
      signal: options.signal,
    });
  }

  /**
   * Walks the trade tape backwards in time.
   *
   * Public market data is rate limited separately from wallet traffic, so a long traversal
   * will be shaped by the client rate limiter rather than failing with a 429.
   */
  async *iterateTrades(
    venue: Venue,
    marketId: string,
    options: { limit?: number; cursor?: string; signal?: AbortSignal } = {},
  ): AsyncGenerator<MarketTrade> {
    let cursor = options.cursor;
    for (;;) {
      const page = await this.trades(venue, marketId, { ...options, cursor });
      yield* page.trades;
      if (!page.has_more || !page.next_cursor) return;
      cursor = page.next_cursor;
    }
  }
}

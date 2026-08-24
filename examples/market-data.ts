/**
 * Public market data: the order book and the trade tape.
 *
 * The point of this one: these routes need no wallet at all, which makes them
 * the right place to start an integration — and the wrong place to look for
 * your own activity. The book is aggregated by price and the tape covers the
 * whole market, so neither can tell you which size or which fill is yours.
 *
 * They also have their own rate limit, counted separately from wallet traffic.
 */
import { PerpClient, decimal } from "@tigercom/perp-sdk";

// No signer is needed for public routes, but the client requires one for the
// authenticated surface. A read-only integration can pass a bare public key.
const client = new PerpClient({
  environment: "development",
  signer: {
    publicKey: "11111111111111111111111111111111",
    async signMessage() {
      throw new Error("this integration is read-only");
    },
  },
});

const VENUE = "PHX";

const venue = await client.discovery.venue(VENUE);
if (!venue?.capabilities?.orderbook) throw new Error(`${VENUE} does not serve an order book`);

const markets = await client.discovery.markets(VENUE);
const market = markets.find((entry) => entry.symbol === "SOL_USDC" && entry.trading_supported);
if (!market) throw new Error("SOL_USDC is not tradable right now");

// ---- book -----------------------------------------------------------------

const book = await client.discovery.orderbook(VENUE, market.market_id, { depth: 5 });

const bestBid = book.bids[0];
const bestAsk = book.asks[0];
if (bestBid && bestAsk) {
  const spread = decimal.subtract(bestAsk.price, bestBid.price);
  console.log(`${book.symbol} @ slot ${book.updated_slot}`);
  console.log(`  bid ${bestBid.price} × ${bestBid.quantity}`);
  console.log(`  ask ${bestAsk.price} × ${bestAsk.quantity}`);
  console.log(`  spread ${spread}`);
}

// Depth on one side, summed exactly rather than through floating point.
const bidDepth = book.bids.reduce((total, level) => decimal.add(total, level.quantity), "0");
console.log(`  ${book.bids.length} bid levels totalling ${bidDepth}`);

// The book is cached for a second and repeats `updated_slot` until the venue
// publishes a newer one — poll against that, not against wall-clock time.
const again = await client.discovery.orderbook(VENUE, market.market_id, { depth: 5 });
console.log(again.updated_slot === book.updated_slot ? "  (same slot, nothing new)" : "  (new slot)");

// ---- tape -----------------------------------------------------------------

const tape = await client.discovery.trades(VENUE, market.market_id, { limit: 10 });
console.log(`\nlast ${tape.trades.length} trades in ${tape.symbol}:`);
for (const trade of tape.trades) {
  console.log(
    `  ${trade.occurred_at} ${trade.side === "B" ? "buy " : "sell"}`,
    `${trade.quantity} @ ${trade.price} = ${trade.quote_amount}`,
  );
}

// Walking further back pages by cursor. The client rate limiter shapes this to
// the public market-data budget instead of letting it 429.
let volume = "0";
let count = 0;
for await (const trade of client.discovery.iterateTrades(VENUE, market.market_id, { limit: 100 })) {
  volume = decimal.add(volume, trade.quote_amount);
  if (++count >= 300) break;
}
console.log(`\n${count} trades totalling ${volume} quote`);

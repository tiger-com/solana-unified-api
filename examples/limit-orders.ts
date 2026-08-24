/**
 * Resting limit orders: place post-only, inspect what actually rested, then
 * cancel selectively or all at once.
 *
 * The point of this one: an accepted command is not a resting order. The
 * command tells you the venue accepted the instruction; the order list tells
 * you what is live. A post-only order that would have crossed is rejected by
 * the venue, so the command can settle while nothing rests.
 */
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";

import { PerpClient, alignPrice, alignQuantity, decimal } from "@tigertrade/perp-sdk";
import { keypairSigner, readKeypairFile } from "@tigertrade/perp-sdk/node";

const client = new PerpClient({
  environment: "development",
  signer: keypairSigner(
    Keypair.fromSecretKey(readKeypairFile(process.env.SOLANA_KEYPAIR_PATH!)),
    nacl.sign.detached,
  ),
});

const VENUE = "PHX";

const venue = await client.discovery.venue(VENUE);
const capabilities = venue?.capabilities?.orders;
if (!capabilities?.limit_gtc) throw new Error("resting limit orders are not enabled here");

const [found] = await client.accounts.list({ venue: VENUE });
if (found?.status !== "ACTIVE") throw new Error("no ACTIVE account");
const account = client.account(found);

// A selected market carries live market_data; the full catalog does not.
const catalog = await client.discovery.markets(VENUE);
const symbol = catalog.find((entry) => entry.symbol === "SOL_USDC")!;
const market = (await client.discovery.market(VENUE, symbol.market_id))!;

const mark = market.market_data?.mark_price;
if (!mark) throw new Error("no mark price available to price against");

// Sit a full percent below the mark so post_only cannot cross the book.
const price = alignPrice(market, decimal.multiply(mark, "0.99"), "down");
const quantity = alignQuantity(market, "0.05");

const placed = await account.place(
  {
    market_id: market.market_id,
    side: "B",
    kind: "LIMIT",
    execution_mode: "GTC",
    quantity,
    limit_price: price,
    // Only valid on LIMIT/GTC, and only where the venue reports it.
    ...(capabilities.post_only ? { post_only: true } : {}),
  },
  { market },
);

const settled = await placed.wait();
if (settled.state === "FAILED") {
  // A post-only order that would have taken liquidity lands here, not on the book.
  throw new Error(`order rejected: ${settled.error_code} ${settled.error_message}`);
}

// What rested is a separate question from what was accepted.
const live = await account.orders({ marketId: market.market_id });
console.log(`${live.orders.length} live order(s) as of slot ${live.snapshot.slot}`);
for (const order of live.orders) {
  const filled = decimal.compare(order.filled_quantity, "0") > 0 ? ` filled ${order.filled_quantity}` : "";
  console.log(`  ${order.venue_order_id} ${order.side} ${order.quantity} @ ${order.limit_price}${filled}`);
}

// Cancel by id when you know exactly which orders to pull. The list is capped
// by the venue, so respect max_cancel_order_ids rather than the generic 30.
const cap = capabilities.max_cancel_order_ids ?? 30;
const stale = live.orders
  .filter((order) => order.purpose === "STANDARD")
  .slice(0, cap)
  .map((order) => order.venue_order_id);

if (stale.length) {
  await (await account.cancel({ market_id: market.market_id, venue_order_ids: stale })).wait();
  console.log(`cancelled ${stale.length} order(s)`);
}

// Or clear the market in one instruction, which avoids racing a fill that
// invalidates an id you collected a moment ago.
if (capabilities.cancel_all) {
  const cleared = await (await account.cancelAll(market.market_id)).wait();
  console.log("cancel-all:", cleared.state);
}

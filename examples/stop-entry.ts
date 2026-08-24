/**
 * Standalone stop-market entry — a resting order that opens a position when the
 * market trades through a trigger.
 *
 * The point of this one: this is the clearest case of a capability that differs
 * by venue. `orders.stop_market` is true on Velocity and false on Phoenix, and
 * it can change per deployment. Reading the flag is not defensive style here,
 * it is the only way to know.
 *
 * Note the shape: a stop entry carries `trigger_price` and nothing else about
 * price. After it activates it executes through the venue's own auction, so
 * there is no `limit_price`, no `post_only`, and no caller-supplied slippage.
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

// Pick whichever enabled venue actually supports stop entries, rather than
// assuming a venue code.
const venues = await client.discovery.venues();
const supported = venues.find((entry) => entry.capabilities?.orders?.stop_market);
if (!supported) {
  console.log("no enabled venue supports stop-market entries:");
  for (const entry of venues) {
    console.log(`  ${entry.venue}: stop_market = ${entry.capabilities?.orders?.stop_market}`);
  }
  process.exit(0);
}

const VENUE = supported.venue;
const [found] = await client.accounts.list({ venue: VENUE });
if (found?.status !== "ACTIVE") throw new Error(`no ACTIVE account on ${VENUE}`);
const account = client.account(found);

const catalog = await client.discovery.markets(VENUE);
const tradable = catalog.find((entry) => entry.trading_supported);
if (!tradable) throw new Error(`no tradable market on ${VENUE}`);

const market = (await client.discovery.market(VENUE, tradable.market_id))!;
const mark = market.market_data?.mark_price;
if (!mark) throw new Error("no mark price to place a trigger against");

// A buy stop sits above the market and a sell stop below; the venue uses its
// own native above/below condition, and activation follows its effective
// trigger price rather than the last trade you happened to see.
const side = "B" as const;
const trigger = alignPrice(market, decimal.multiply(mark, side === "B" ? "1.02" : "0.98"));
const quantity = alignQuantity(market, market.minimum_quantity);

console.log(`${market.symbol} mark ${mark} → ${side === "B" ? "buy" : "sell"} stop at ${trigger}`);

const stop = await account.place(
  {
    market_id: market.market_id,
    side,
    kind: "CONDITIONAL",
    execution_mode: "GTC",
    quantity,
    trigger_price: trigger,
    // No limit_price, post_only, or max_slippage_bps: the SDK rejects those
    // locally rather than letting the venue return an opaque 400.
  },
  { market },
);

const settled = await stop.wait();
console.log("stop entry:", settled.state);

// A resting stop reports as kind CONDITIONAL with purpose STANDARD, which is
// what distinguishes it from a stop-loss attached to a position.
const { orders } = await account.orders({ marketId: market.market_id });
for (const order of orders.filter((entry) => entry.kind === "CONDITIONAL")) {
  console.log(
    `resting stop ${order.venue_order_id}: ${order.side} ${order.quantity} @ trigger ${order.trigger_price}`,
    `(purpose ${order.purpose}, origin ${order.origin})`,
  );
}

// On some venues a resting stop and its keeper-triggered fill cannot yet be
// bound back to the placement, so they may report origin UNKNOWN with no
// client_order_id. The command still tracks the placement transaction.

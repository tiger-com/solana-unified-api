/**
 * Repricing a resting order.
 *
 * The point of this one: there is no amend endpoint. Repricing is cancel, then
 * place — two separate commands, with a window in between where you hold no
 * order. Doing it in the wrong order, or without waiting, is how you end up
 * with two live orders instead of one.
 *
 * Cancel first and wait for it to settle. The alternative — place then cancel —
 * risks both resting simultaneously and doubling your exposure if the market
 * comes to you in between.
 */
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";

import {
  PerpClient,
  alignPrice,
  decimal,
  isCommandError,
  type AccountHandle,
  type Command,
  type Market,
  type Order,
  type SubmittedCommand,
} from "@tigertrade/perp-sdk";
import { keypairSigner, readKeypairFile } from "@tigertrade/perp-sdk/node";

const client = new PerpClient({
  environment: "development",
  signer: keypairSigner(
    Keypair.fromSecretKey(readKeypairFile(process.env.SOLANA_KEYPAIR_PATH!)),
    nacl.sign.detached,
  ),
});

const VENUE = "PHX";

const [found] = await client.accounts.list({ venue: VENUE });
if (found?.status !== "ACTIVE") throw new Error("no ACTIVE account");
const account = client.account(found);

const markets = await client.discovery.markets(VENUE);
const market = markets.find((entry) => entry.symbol === "SOL_USDC")!;

/** Settles a command, following it through an uncertain submission. */
async function settle(
  handle: AccountHandle,
  submit: () => Promise<SubmittedCommand>,
): Promise<Command> {
  try {
    return await (await submit()).wait();
  } catch (error) {
    // 502/503 still carry the stored command. Poll it — a replacement intent
    // here could cancel twice or place twice.
    if (!isCommandError(error)) throw error;
    return handle.waitFor(error.command.request_id);
  }
}

/**
 * Moves one resting order to a new price.
 *
 * Returns the quantity actually re-placed, which is the *unfilled* remainder:
 * anything that filled before the cancel landed is already a position, and
 * re-placing the original size would double it.
 */
async function reprice(
  handle: AccountHandle,
  target: Market,
  order: Order,
  newPrice: string,
): Promise<string | null> {
  const cancelled = await settle(handle, () =>
    handle.cancel({ market_id: order.market_id, venue_order_ids: [order.venue_order_id] }),
  );
  if (cancelled.state === "FAILED") {
    // Most often the order already filled or was pulled by the venue.
    console.warn("cancel failed:", cancelled.error_code, cancelled.error_message);
    return null;
  }

  // Re-read rather than trusting the pre-cancel view: the fill state moved.
  const after = await handle.orders({ marketId: order.market_id });
  if (after.orders.some((entry) => entry.venue_order_id === order.venue_order_id)) {
    console.warn("order is still resting after a settled cancel; not replacing it");
    return null;
  }

  const remaining = decimal.subtract(order.quantity, order.filled_quantity);
  if (decimal.compare(remaining, target.minimum_quantity) < 0) {
    console.log(`only ${remaining} left unfilled; below minimum_quantity, nothing to replace`);
    return null;
  }

  const placed = await settle(handle, () =>
    handle.place(
      {
        market_id: order.market_id,
        side: order.side,
        kind: "LIMIT",
        execution_mode: "GTC",
        quantity: remaining,
        limit_price: newPrice,
        post_only: order.post_only,
      },
      { market: target },
    ),
  );
  if (placed.state === "FAILED") {
    // The window is now empty on purpose: the old order is gone and the new one
    // was refused. Surface it rather than silently holding nothing.
    throw new Error(`replacement rejected: ${placed.error_code} ${placed.error_message}`);
  }
  return remaining;
}

const { orders } = await account.orders({ marketId: market.market_id });
const resting = orders.find((entry) => entry.purpose === "STANDARD" && entry.limit_price);
if (!resting) {
  console.log("no resting limit order to reprice");
  process.exit(0);
}

// Nudge a buy up, a sell down — one tick toward the market.
const step = resting.side === "B" ? market.price_tick : decimal.negate(market.price_tick);
const target = alignPrice(market, decimal.add(resting.limit_price!, step));

console.log(`repricing ${resting.venue_order_id} from ${resting.limit_price} to ${target}`);
const replaced = await reprice(account, market, resting, target);
console.log(replaced ? `re-placed ${replaced} @ ${target}` : "nothing re-placed");

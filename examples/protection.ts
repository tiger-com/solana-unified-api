/**
 * Take-profit and stop-loss on an open position.
 *
 * The point of this one: protection is native venue state attached to the
 * position, not a pair of orders you manage. Setting it replaces whatever was
 * configured before, and it is fingerprinted like `reduce` — so it cannot land
 * on a position that changed while you were deciding.
 *
 * The resulting orders show up in the order list with `purpose` of
 * `TAKE_PROFIT` or `STOP_LOSS`, which is how you read back what is armed.
 */
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";

import { PerpClient, alignPrice, decimal, hasErrorCode } from "@tigercom/perp-sdk";
import { keypairSigner, readKeypairFile } from "@tigercom/perp-sdk/node";

const client = new PerpClient({
  environment: "development",
  signer: keypairSigner(
    Keypair.fromSecretKey(readKeypairFile(process.env.SOLANA_KEYPAIR_PATH!)),
    nacl.sign.detached,
  ),
});

const VENUE = "PHX";
const SYMBOL = "SOL_USDC";

const venue = await client.discovery.venue(VENUE);
if (!venue?.capabilities?.positions?.protection) {
  throw new Error("this venue does not expose native position protection");
}

const [found] = await client.accounts.list({ venue: VENUE });
if (found?.status !== "ACTIVE") throw new Error("no ACTIVE account");
const account = client.account(found);

const markets = await client.discovery.markets(VENUE);
const market = markets.find((entry) => entry.symbol === SYMBOL)!;

const state = await account.freshState();
const position = state.positions.find((entry) => entry.market_id === market.market_id);
if (!position || decimal.isZero(position.quantity)) {
  throw new Error(`no open ${SYMBOL} position to protect`);
}

// Price the brackets off the entry, and mind the direction: a long takes profit
// above and stops below, a short is the mirror image.
const isLong = decimal.isPositive(position.quantity);
const reference = position.entry_price ?? position.mark_price;
if (!reference) throw new Error("position has no entry or mark price to price against");

const takeProfit = alignPrice(market, decimal.multiply(reference, isLong ? "1.10" : "0.90"));
const stopLoss = alignPrice(market, decimal.multiply(reference, isLong ? "0.95" : "1.05"));

console.log(
  `${isLong ? "long" : "short"} ${decimal.abs(position.quantity)} from ${reference}`,
  `→ TP ${takeProfit} / SL ${stopLoss}`,
);

try {
  const armed = await account.setProtection(market.market_id, {
    expected_snapshot_fingerprint: state.fingerprint,
    take_profit_price: takeProfit,
    stop_loss_price: stopLoss,
    // Bounds the stop's market execution once it triggers. Requires stop_loss_price.
    stop_loss_slippage_bps: 100,
  });

  const settled = await armed.wait();
  if (settled.state === "FAILED") {
    throw new Error(`protection rejected: ${settled.error_code} ${settled.error_message}`);
  }
} catch (error) {
  if (hasErrorCode(error, "stale_state")) {
    // Nothing was stored: re-read state and set protection again from scratch.
    console.warn("position moved while arming protection; re-read state and retry");
  }
  if (hasErrorCode(error, "not_supported")) {
    console.warn("this shape is not supported on this venue despite the capability flag");
  }
  throw error;
}

// Read back what is armed. Protection surfaces as orders with a non-STANDARD purpose.
for (const purpose of ["TAKE_PROFIT", "STOP_LOSS"] as const) {
  const { orders } = await account.orders({ marketId: market.market_id, purpose });
  for (const order of orders) {
    console.log(`${purpose}: trigger ${order.trigger_price ?? "n/a"} for ${order.quantity}`);
  }
}

// Clearing one side means re-sending the side you want to keep: the command
// sets the position's protection as a whole rather than patching one field.
const fresh = await account.freshState();
const tpOnly = await account.setProtection(market.market_id, {
  expected_snapshot_fingerprint: fresh.fingerprint,
  take_profit_price: takeProfit,
});
console.log("take-profit only:", (await tpOnly.wait()).state);

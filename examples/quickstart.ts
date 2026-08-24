/**
 * Login → discover → read state → place an order → follow it to a terminal state.
 *
 * Run with a Solana CLI keypair path in SOLANA_KEYPAIR_PATH.
 * This is mainnet: the order below is real.
 */
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";

import { PerpClient, decimal } from "@tigertrade/perp-sdk";
import { keypairSigner, readKeypairFile } from "@tigertrade/perp-sdk/node";

const keypair = Keypair.fromSecretKey(readKeypairFile(process.env.SOLANA_KEYPAIR_PATH!));

const client = new PerpClient({
  environment: "development",
  signer: keypairSigner(keypair, nacl.sign.detached),
});

// 1. Discover. Never hardcode a venue set, a market id, or a capability.
const venues = await client.discovery.venues();
const phoenix = venues.find((venue) => venue.venue === "PHX");
if (!phoenix?.capabilities?.orders?.market_ioc) {
  throw new Error("market orders are not available on this deployment");
}

const markets = await client.discovery.markets("PHX");
const market = markets.find((entry) => entry.symbol === "SOL_USDC" && entry.trading_supported);
if (!market) throw new Error("SOL_USDC is not tradable right now");

// 2. Bind a handle to one account. Every call below then drops the
//    (venue, native_account) pair instead of repeating it.
const found = (await client.accounts.list({ venue: "PHX" })).find(
  (entry) => entry.status === "ACTIVE",
);
if (!found) throw new Error("no ACTIVE account — run examples/onboarding.ts first");
const account = client.account(found);

const state = await account.freshState();
console.log("equity:", state.equity, "free collateral:", state.free_collateral);

// 3. Size the order with exact decimals and let the SDK check it locally.
const quantity = decimal.roundToMultiple("0.017", market.quantity_step, "down");

const order = await account.place(
  {
    market_id: market.market_id,
    side: "B",
    kind: "MARKET",
    execution_mode: "IOC",
    quantity,
    max_slippage_bps: 100,
  },
  { market },
);
console.log(order.created ? "admitted" : "replayed", order.command.request_id, order.command.state);

// 4. A 202 means the intent is durable, not that it executed. Waiting stays
//    explicit; the handle just spares you carrying the request_id around.
const settled = await order.wait({ onState: (observed) => console.log("state:", observed.state) });

if (settled.state === "FAILED") {
  console.error("failed:", settled.error_code, settled.error_message);
} else {
  console.log("settled:", settled.state, settled.signature);
}

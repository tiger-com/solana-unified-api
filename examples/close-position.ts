/**
 * Reducing and closing a position.
 *
 * The point of this one: `reduce` is fingerprinted. It carries the identity of
 * the snapshot you decided from, and the venue refuses it if that snapshot has
 * been superseded. That is what stops a reduce sized against a position you no
 * longer have.
 *
 * When it does refuse, the intent was never admitted — so the recovery is a
 * *new* `request_id` against fresh state, which is the one place in this API
 * where a new key is correct rather than dangerous.
 */
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";

import {
  PerpClient,
  decimal,
  hasErrorCode,
  type AccountHandle,
  type Command,
  type Position,
} from "@tigercom/perp-sdk";
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

const [found] = await client.accounts.list({ venue: VENUE });
if (!found) throw new Error("no accounts");
const account = client.account(found);

/**
 * Reduces a position, re-deriving the fingerprint if the snapshot moves under us.
 *
 * Each attempt reads fresh state and submits a fresh intent, because a
 * `stale_state` rejection happens before the command is stored.
 */
async function reduceBy(
  handle: AccountHandle,
  marketId: string,
  size: (position: Position) => string,
  attempts = 3,
): Promise<Command> {
  for (let attempt = 1; ; attempt++) {
    const state = await handle.freshState();
    const position = state.positions.find((entry) => entry.market_id === marketId);

    if (!position || decimal.isZero(position.quantity)) {
      throw new Error(`no open position in market ${marketId}`);
    }

    const quantity = size(position);
    if (!decimal.isPositive(quantity)) {
      throw new Error(`reduce quantity must be positive, computed ${quantity}`);
    }

    try {
      const submitted = await handle.reduce(marketId, {
        // Identity of the exact snapshot this size was derived from.
        expected_snapshot_fingerprint: state.fingerprint,
        // Always positive: direction comes from the position, not from you.
        quantity,
        kind: "MARKET",
        execution_mode: "IOC",
        max_slippage_bps: 100,
      });
      return await submitted.wait();
    } catch (error) {
      if (attempt >= attempts || !hasErrorCode(error, "stale_state")) throw error;
      // The position moved between the read and the write. Nothing was stored,
      // so re-read and submit a genuinely new intent.
      console.warn(`snapshot superseded, re-reading (attempt ${attempt}/${attempts})`);
    }
  }
}

const markets = await client.discovery.markets(VENUE);
const market = markets.find((entry) => entry.symbol === SYMBOL)!;

const venue = await client.discovery.venue(VENUE);
const capabilities = venue?.capabilities?.orders;

// Show the position before touching it. `quantity` is signed: the sign is the
// direction, and every valuation field beside it may be null.
const before = await account.freshState();
const position = before.positions.find((entry) => entry.market_id === market.market_id);
if (!position) throw new Error(`no ${SYMBOL} position to close`);

console.log(
  `${position.symbol}: ${decimal.isNegative(position.quantity) ? "short" : "long"}`,
  decimal.abs(position.quantity),
  "entry",
  position.entry_price ?? "n/a",
  "unrealized",
  position.unrealized_pnl ?? "n/a",
);

// Halve it first — partial reduction is its own capability.
if (capabilities?.partial_reduce) {
  const half = decimal.roundToMultiple(
    decimal.multiply(decimal.abs(position.quantity), "0.5"),
    market.quantity_step,
    "down",
  );
  if (decimal.compare(half, market.minimum_quantity) >= 0) {
    const settled = await reduceBy(account, market.market_id, () => half);
    console.log("partial reduce:", settled.state);
  } else {
    console.log("half the position is below minimum_quantity; skipping partial reduce");
  }
}

// Then close whatever remains. Sizing from the same snapshot the fingerprint
// came from is what makes "close everything" exact rather than approximate.
if (capabilities?.full_reduce_market_ioc) {
  const settled = await reduceBy(account, market.market_id, (current) =>
    decimal.abs(current.quantity),
  );
  console.log("close:", settled.state);

  const after = await account.freshState();
  const remaining = after.positions.find((entry) => entry.market_id === market.market_id);
  console.log("remaining:", remaining ? remaining.quantity : "flat");
}

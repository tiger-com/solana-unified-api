/**
 * Reading account state correctly: margin, PnL, and funding.
 *
 * The point of this one is the funding arithmetic, which is easy to get wrong
 * in a way that quietly overstates the account:
 *
 *   - `positions[].funding` is the current signed **unsettled** amount, not
 *     lifetime accumulation. Positive is receivable, negative is owed.
 *   - It is **already included in `equity`**. Adding it again double-counts.
 *   - Phoenix finalises it when the cumulative funding rate rolls, hourly at
 *     present. Do not prorate it by elapsed seconds: a position opened a minute
 *     before the roll can take the full hourly step.
 *   - Settlement moves the amount from position funding into deposited
 *     collateral. That changes the decomposition without changing `equity`, so
 *     reconcile the two together rather than one at a time.
 *
 * Everything below `quantity` on a position is nullable, so every read here is
 * defensive by necessity rather than by habit.
 */
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";

import { PerpClient, decimal } from "@tigercom/perp-sdk";
import { keypairSigner, readKeypairFile } from "@tigercom/perp-sdk/node";

const client = new PerpClient({
  environment: "development",
  signer: keypairSigner(
    Keypair.fromSecretKey(readKeypairFile(process.env.SOLANA_KEYPAIR_PATH!)),
    nacl.sign.detached,
  ),
});

const VENUE = "PHX";
const show = (value: string | null | undefined) => value ?? "—";

for (const handle of await client.accountHandles({ venue: VENUE })) {
  const { account, state } = await handle.get();

  if (!state) {
    console.log(`${account.name}: ${account.status} — no live state`);
    continue;
  }

  // A stale snapshot is a fallback projection, still HTTP 200. Fine to display
  // with a caveat; never fine to derive a command fingerprint from.
  if (state.stale) {
    console.warn(`${account.name}: stale snapshot, retry in ${state.retry_after_seconds}s`);
  }

  console.log(`\n${account.name} (${account.status}) — slot ${state.slot}, lag ${state.lag_slots}`);
  console.log(
    `  equity ${show(state.equity)}  free ${show(state.free_collateral)}`,
    `used ${show(state.margin_used)}  maintenance ${show(state.maintenance_margin)}`,
  );

  for (const balance of state.balances) {
    console.log(
      `  ${balance.symbol}: deposited ${balance.deposited}`,
      `borrowed ${balance.borrowed} withdrawable ${show(balance.available_withdraw)}`,
    );
  }

  let unsettledFunding = "0";
  let unrealized = "0";

  for (const position of state.positions) {
    if (decimal.isZero(position.quantity)) continue;

    const direction = decimal.isNegative(position.quantity) ? "short" : "long";
    console.log(
      `  ${position.symbol}: ${direction} ${decimal.abs(position.quantity)}`,
      `entry ${show(position.entry_price)} mark ${show(position.mark_price)}`,
      `liq ${show(position.liquidation_price)}`,
    );
    console.log(
      `    unrealized ${show(position.unrealized_pnl)} realized ${show(position.realized_pnl)}`,
      `funding ${show(position.funding)} ${position.funding_asset ?? ""}`.trimEnd(),
    );

    if (position.funding) {
      unsettledFunding = decimal.add(unsettledFunding, position.funding);
    }
    if (position.unrealized_pnl) {
      unrealized = decimal.add(unrealized, position.unrealized_pnl);
    }

    // origin_command_id ties the position back to the intent that opened it,
    // when the chain evidence supports the attribution.
    if (position.origin_command_id) {
      console.log(`    opened by command ${position.origin_command_id}`);
    }
  }

  console.log(`  total unrealized ${unrealized}, unsettled funding ${unsettledFunding}`);

  if (decimal.isNegative(unsettledFunding)) {
    console.log(`  you owe ${decimal.abs(unsettledFunding)} at the next funding roll`);
  }

  // Correct: equity already contains funding, so this is a consistency check,
  // never a correction to apply.
  //
  //   equity ≈ deposited collateral + unrealized PnL + unsettled funding
  //
  // Wrong: `equity + unsettledFunding`, which counts it twice.
  const quoteOnly = state.balances.length === 1 && state.balances[0];
  if (quoteOnly && state.equity) {
    const modelled = decimal.add(decimal.add(quoteOnly.deposited, unrealized), unsettledFunding);
    const drift = decimal.subtract(state.equity, modelled);
    console.log(`  equity ${state.equity} vs modelled ${modelled} (drift ${drift})`);
    console.log("  drift is expected when spot collateral is held; it is not missing funding");
  }
}

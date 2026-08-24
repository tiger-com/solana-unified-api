/**
 * Streams live executions and position events, and backfills the gap.
 *
 * The stream is live-only: connecting replays nothing. Executions and ledger
 * fills share the same opaque `source_key`, so the two reconcile by exact
 * string equality — which is what makes "stream now, backfill after" safe.
 */
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";

import { PerpClient } from "@tigercom/perp-sdk";
import { keypairSigner, readKeypairFile } from "@tigercom/perp-sdk/node";
import { subscribeEvents } from "@tigercom/perp-sdk/realtime";

const client = new PerpClient({
  signer: keypairSigner(
    Keypair.fromSecretKey(readKeypairFile(process.env.SOLANA_KEYPAIR_PATH!)),
    nacl.sign.detached,
  ),
});

const [found] = await client.accounts.list({ venue: "PHX" });
if (!found) throw new Error("no accounts");
const account = client.account(found);

const seen = new Set<string>();

// Subscribe first, so nothing that happens during the backfill is missed.
const stream = await subscribeEvents(client, {
  onExecution: (event) => {
    seen.add(event.source_key);
    console.log(
      "fill",
      event.market.symbol,
      event.side,
      event.quantity,
      "@",
      event.price,
      event.liquidity,
    );
  },
  onPosition: (event) => {
    if (event.participant_was_liquidated) console.warn("liquidated:", event.market.symbol);
    console.log("position", event.market.symbol, event.position_after?.quantity ?? "closed");
  },
  onDisconnected: ({ reason }) => console.warn("disconnected:", reason),
  onError: (error) => console.error("realtime error:", error),
});

console.log("subscribed to", stream.channel);

// Then backfill recent history, skipping anything the stream already delivered.
for await (const event of account.iterateLedger({ limit: 100 })) {
  if (event.event_type !== "FILL" || !event.fill) continue;
  if (seen.has(event.fill.source_key)) continue;
  seen.add(event.fill.source_key);
  console.log("backfill", event.fill.symbol, event.fill.quantity, "@", event.fill.price);
}

process.on("SIGINT", () => {
  stream.close();
  process.exit(0);
});

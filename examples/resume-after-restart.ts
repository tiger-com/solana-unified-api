/**
 * What to do on start-up when a previous run may have left an intent in flight.
 *
 * The rule this demonstrates: a command that is not terminal is still live.
 * Resume it. Never issue a replacement `request_id` because polling timed out —
 * that is how an integration double-fills.
 */
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";

import { PerpClient, isCommandError } from "@tigercom/perp-sdk";
import { keypairSigner, readKeypairFile } from "@tigercom/perp-sdk/node";

const client = new PerpClient({
  signer: keypairSigner(
    Keypair.fromSecretKey(readKeypairFile(process.env.SOLANA_KEYPAIR_PATH!)),
    nacl.sign.detached,
  ),
});

// A handle per owned account, so reconciliation covers all of them.
for (const account of await client.accountHandles({ venue: "PHX" })) {
  // 1. Reconcile before doing anything new.
  for (const command of await account.pendingCommands()) {
    console.log("resuming", command.kind, command.request_id, command.state);
    const settled = await account.waitFor(command.request_id, { timeoutMs: 120_000 });
    console.log("  →", settled.state);
  }

  // 2. Only now submit new intents.
  try {
    const cancelled = await account.cancelAll("0");
    console.log("cancel-all:", (await cancelled.wait()).state);
  } catch (error) {
    // 502/503 responses still carry the stored command: poll it, do not resend.
    if (!isCommandError(error)) throw error;
    console.warn("submission uncertain; following the stored command instead");
    const settled = await account.waitFor(error.command.request_id);
    console.log("settled:", settled.state);
  }
}

/**
 * Onboards a wallet to an ACTIVE Phoenix account, then funds it.
 *
 * This spends real SOL on venue account rent and network fees, requires mainnet
 * USDC for the deposit, and prompts the signer several times. Gate it behind an
 * explicit user action.
 */
import { Connection, Keypair, type VersionedTransaction } from "@solana/web3.js";
import nacl from "tweetnacl";

import { PerpClient } from "@tigertrade/perp-sdk";
import { readKeypairFile } from "@tigertrade/perp-sdk/node";
import { completeSetup, submitCollateral, type Web3Signer } from "@tigertrade/perp-sdk/solana";

const keypair = Keypair.fromSecretKey(readKeypairFile(process.env.SOLANA_KEYPAIR_PATH!));

// One signer that covers both the login challenge and transaction signing.
const signer: Web3Signer = {
  publicKey: keypair.publicKey,
  async signMessage(message) {
    return nacl.sign.detached(message, keypair.secretKey);
  },
  async signTransaction(transaction: VersionedTransaction) {
    transaction.sign([keypair]);
    return transaction;
  },
};

// The SDK never creates a Connection: you choose the RPC and its commitment.
const connection = new Connection(process.env.SOLANA_RPC_URL!, "confirmed");
const client = new PerpClient({ environment: "development", signer });

const created = await completeSetup(client, "PHX", {
  connection,
  signer,
  name: "Main",
  onProgress: ({ phase, signature }) =>
    console.log("setup:", phase, signature ? `(${signature})` : ""),
});

console.log("account is", created.status, created.native_account);

// Bind a handle so the remaining calls drop the (venue, native_account) pair.
const account = client.account(created);

// Collateral is owner-signed too. The API builds the transaction; it never
// submits it, and there is no confirm endpoint — observe the result in state.
const deposit = await account.deposit("25");
const signature = await submitCollateral({ connection, signer, transaction: deposit });
console.log("deposited", deposit.amount, deposit.asset, "in", signature);

const state = await account.freshState();
console.log("free collateral:", state.free_collateral);

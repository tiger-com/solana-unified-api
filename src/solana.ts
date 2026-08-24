/**
 * Transaction helpers for onboarding, collateral, and revocation.
 *
 * Requires the `@solana/web3.js` peer dependency. It is intentionally *not*
 * bundled: two copies of web3.js in one application break `instanceof` checks
 * and stop you from sharing a single `Connection`. The caller supplies the
 * `Connection`, so the SDK never picks an RPC endpoint or a commitment on your
 * behalf.
 */
import { VersionedTransaction } from "@solana/web3.js";
import type { Commitment, Connection } from "@solana/web3.js";

import { decodeBase64, encodeBase64 } from "./base64.js";
import type { PerpClient } from "./client.js";
import { PerpUsageError } from "./errors.js";
import type { PerpTransactionSigner } from "./signer.js";
import type { Account, AccountSetup, CollateralTransaction, Venue } from "./types.js";

/** The transaction fields every signed step of the API carries. */
export interface TransactionStep {
  transaction: string;
  recent_blockhash: string;
  last_valid_block_height: number;
}

export type Web3Signer = PerpTransactionSigner<VersionedTransaction>;

/** Deserialises a base64 v0 wire transaction without altering it. */
export const deserializeTransaction = (base64: string): VersionedTransaction =>
  VersionedTransaction.deserialize(decodeBase64(base64));

/**
 * Signs a returned transaction and returns it as base64.
 *
 * Used for the registration step, whose wire must reach Tiger rather than the
 * network: it is incomplete until the venue onboarder co-signs it, so
 * broadcasting it directly fails on chain.
 */
export async function signTransactionStep(
  signer: Web3Signer,
  step: TransactionStep,
): Promise<string> {
  const signed = await signer.signTransaction(deserializeTransaction(step.transaction));
  return encodeBase64(signed.serialize());
}

/**
 * Signs, submits, and waits for the transaction to finalize.
 *
 * Confirms at `finalized` by default because the API's confirm endpoints expect
 * a finalized signature; confirming earlier can leave an account stuck
 * mid-setup if the block is later dropped.
 */
export async function submitAndConfirm(options: {
  connection: Connection;
  signer: Web3Signer;
  step: TransactionStep;
  commitment?: Commitment;
}): Promise<string> {
  const { connection, signer, step, commitment = "finalized" } = options;

  const currentHeight = await connection.getBlockHeight("confirmed");
  if (currentHeight > step.last_valid_block_height) {
    // Submitting an expired wire wastes a fee and returns a confusing error.
    throw new PerpUsageError(
      "transaction blockhash has expired; request a new step instead of submitting it",
    );
  }

  const signed = await signer.signTransaction(deserializeTransaction(step.transaction));
  const signature = await connection.sendRawTransaction(signed.serialize(), {
    // The API already simulated and validated this wire.
    skipPreflight: false,
    maxRetries: 3,
  });

  const result = await connection.confirmTransaction(
    {
      signature,
      blockhash: step.recent_blockhash,
      lastValidBlockHeight: step.last_valid_block_height,
    },
    commitment,
  );
  if (result.value.err) {
    throw new PerpUsageError(
      `transaction ${signature} failed on chain: ${JSON.stringify(result.value.err)}`,
    );
  }
  return signature;
}

/** Signs, submits, and finalizes a collateral deposit or withdrawal. */
export const submitCollateral = (options: {
  connection: Connection;
  signer: Web3Signer;
  transaction: CollateralTransaction;
  commitment?: Commitment;
}): Promise<string> =>
  submitAndConfirm({
    connection: options.connection,
    signer: options.signer,
    step: options.transaction,
    commitment: options.commitment,
  });

export interface SetupProgress {
  phase: AccountSetup["setup_phase"] | "POLLING" | "DONE";
  account: AccountSetup | Account;
  /** Signature of a submitted transaction, when this step produced one. */
  signature?: string;
}

export interface CompleteSetupOptions {
  connection: Connection;
  signer: Web3Signer;
  /** Display name, used only when the account is created. */
  name?: string;
  /** Delay between polls while a step or the outbox settles. */
  pollIntervalMs?: number;
  /** Safety bound on state transitions. Defaults to 40. */
  maxSteps?: number;
  onProgress?: (progress: SetupProgress) => void;
  commitment?: Commitment;
  signal?: AbortSignal;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Drives account onboarding to `ACTIVE`.
 *
 * This spends real SOL on venue account rent and network fees, and it prompts
 * the wallet more than once. Gate it behind an explicit user action rather than
 * calling it on application start.
 *
 * Each round re-reads the server's state instead of tracking its own step
 * counter, so an interrupted run resumes correctly by simply calling it again.
 */
export async function completeSetup(
  client: PerpClient,
  venue: Venue,
  options: CompleteSetupOptions,
): Promise<Account> {
  const poll = options.pollIntervalMs ?? 1500;
  const maxSteps = options.maxSteps ?? 40;

  let current: AccountSetup = await client.accounts.create(venue, {
    name: options.name,
    signal: options.signal,
  });

  for (let step = 0; step < maxSteps; step++) {
    const native = current.native_account;

    if (current.status === "ACTIVE") {
      options.onProgress?.({ phase: "DONE", account: current });
      return current;
    }
    if (current.status === "REVOKED" || current.status === "PAUSED") {
      throw new PerpUsageError(
        `account ${native} is ${current.status}; onboarding cannot continue from that state`,
      );
    }

    if (current.setup_phase === "REGISTRATION") {
      options.onProgress?.({ phase: "REGISTRATION", account: current });
      if (current.transaction) {
        // Signed but never broadcast: Tiger forwards it for co-signature.
        const signedTransaction = await signTransactionStep(options.signer, {
          transaction: current.transaction,
          recent_blockhash: current.recent_blockhash!,
          last_valid_block_height: current.last_valid_block_height!,
        });
        current = await client.accounts.continueSetup(
          venue,
          native,
          { setup_step_id: current.setup_step_id!, signed_transaction: signedTransaction },
          options.signal,
        );
      } else {
        await wait(poll);
        current = await client.accounts.continueSetup(venue, native, undefined, options.signal);
      }
      continue;
    }

    if (current.setup_phase === "DELEGATION") {
      const signature = await submitAndConfirm({
        connection: options.connection,
        signer: options.signer,
        step: {
          transaction: current.transaction!,
          recent_blockhash: current.recent_blockhash!,
          last_valid_block_height: current.last_valid_block_height!,
        },
        commitment: options.commitment,
      });
      options.onProgress?.({ phase: "DELEGATION", account: current, signature });

      await client.accounts.confirmSetup(
        venue,
        native,
        { setup_step_id: current.setup_step_id!, signature },
        options.signal,
      );
      const refreshed = await client.accounts.get(venue, native, options.signal);
      current = refreshed.account;
      continue;
    }

    // PENDING with no phase: on-chain setup is done, delivery is finishing.
    options.onProgress?.({ phase: "POLLING", account: current });
    await wait(poll);
    const refreshed = await client.accounts.get(venue, native, options.signal);
    current = refreshed.account;
  }

  throw new PerpUsageError(
    `onboarding did not reach ACTIVE within ${maxSteps} steps; ` +
      `re-read the account and call completeSetup again to resume`,
  );
}

/**
 * Drives delegate revocation to `REVOKED`.
 *
 * The account must be `PAUSED` first — call `client.accounts.disable(...)`.
 * Revocation keeps the account row and its history but destroys the delegate.
 */
export async function completeRevocation(
  client: PerpClient,
  venue: Venue,
  nativeAccount: string,
  options: Omit<CompleteSetupOptions, "name">,
): Promise<Account> {
  const step = await client.accounts.revoke(venue, nativeAccount, options.signal);

  if (step.transaction) {
    const signature = await submitAndConfirm({
      connection: options.connection,
      signer: options.signer,
      step: {
        transaction: step.transaction,
        recent_blockhash: step.recent_blockhash!,
        last_valid_block_height: step.last_valid_block_height!,
      },
      commitment: options.commitment,
    });
    options.onProgress?.({ phase: "REVOCATION", account: step, signature });

    await client.accounts.confirmRevocation(
      venue,
      nativeAccount,
      { setup_step_id: step.setup_step_id!, signature },
      options.signal,
    );
  }

  const { account } = await client.accounts.get(venue, nativeAccount, options.signal);
  return account;
}

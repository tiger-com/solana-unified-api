/**
 * Browser helpers.
 *
 * Note: the API currently sends `Access-Control-Allow-Origin` only for the
 * Tiger web terminal. A browser client on any other origin needs that origin
 * allow-listed before these calls will succeed.
 */
import { PerpUsageError } from "./errors.js";
import type { PerpSigner, PerpTransactionSigner } from "./signer.js";

/** The parts of a `@solana/wallet-adapter` wallet this SDK uses. */
export interface WalletAdapterLike {
  publicKey: { toBase58(): string } | null;
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
  signTransaction?: <T>(transaction: T) => Promise<T>;
}

/**
 * Adapts a connected wallet-adapter wallet to `PerpSigner`.
 *
 * Call it after the wallet connects: an unconnected adapter has a `null`
 * public key, and failing here is clearer than a `401` later.
 */
export function walletAdapterSigner(wallet: WalletAdapterLike): PerpSigner {
  if (!wallet.publicKey) {
    throw new PerpUsageError("wallet is not connected: publicKey is null");
  }
  if (typeof wallet.signMessage !== "function") {
    throw new PerpUsageError(
      "wallet does not support signMessage, which is required to authenticate",
    );
  }
  const signMessage = wallet.signMessage.bind(wallet);
  return { publicKey: wallet.publicKey, signMessage };
}

/**
 * Same, but also exposes transaction signing for onboarding, collateral, and
 * revocation.
 */
export function walletAdapterTransactionSigner<Transaction>(
  wallet: WalletAdapterLike,
): PerpTransactionSigner<Transaction> {
  const base = walletAdapterSigner(wallet);
  if (typeof wallet.signTransaction !== "function") {
    throw new PerpUsageError("wallet does not support signTransaction");
  }
  const signTransaction = wallet.signTransaction.bind(wallet) as (
    transaction: Transaction,
  ) => Promise<Transaction>;
  return { ...base, signTransaction };
}

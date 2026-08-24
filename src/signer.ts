/**
 * Minimal public-key shape.
 *
 * A `PublicKey` from `@solana/web3.js` satisfies this structurally, so the core
 * package needs no dependency on web3.js to accept one.
 */
export interface WalletPublicKey {
  toBase58(): string;
}

/**
 * What the SDK needs from a wallet in order to authenticate.
 *
 * Deliberately the same shape as a wallet-adapter wallet and as Drift's
 * `IWalletV2`, so an existing wallet object drops in without a shim.
 */
export interface PerpSigner {
  /** Owner wallet public key, as an object or canonical base58 string. */
  readonly publicKey: WalletPublicKey | string;
  /**
   * Signs the exact message bytes and returns a detached Ed25519 signature.
   *
   * The API's challenge message must be signed byte-for-byte: do not trim,
   * normalise, re-wrap, or rebuild it.
   */
  signMessage(message: Uint8Array): Promise<Uint8Array>;
}

/**
 * A signer that can also sign Solana transactions, needed for onboarding,
 * collateral, and revocation. Used by `@tigertrade/perp-sdk/solana`.
 */
export interface PerpTransactionSigner<Transaction = unknown> extends PerpSigner {
  signTransaction(transaction: Transaction): Promise<Transaction>;
}

export const ownerPubkey = (signer: PerpSigner): string =>
  typeof signer.publicKey === "string" ? signer.publicKey : signer.publicKey.toBase58();

export const canSignTransactions = <T>(
  signer: PerpSigner,
): signer is PerpTransactionSigner<T> =>
  typeof (signer as PerpTransactionSigner<T>).signTransaction === "function";

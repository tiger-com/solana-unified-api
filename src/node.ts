/**
 * Node helpers. Importing this entry pulls in `node:fs`, so it must not reach a
 * browser bundle — use `@tigercom/perp-sdk/browser` there.
 */
import { readFileSync } from "node:fs";

import { PerpUsageError } from "./errors.js";
import type { PerpSigner } from "./signer.js";

/** Minimal shape of a `Keypair` from `@solana/web3.js`. */
export interface KeypairLike {
  publicKey: { toBase58(): string };
  secretKey: Uint8Array;
}

/**
 * Signer backed by an Ed25519 secret key.
 *
 * `sign` is injected rather than imported so the core package does not depend
 * on a crypto library; pass `nacl.sign.detached` from `tweetnacl`, or any
 * equivalent.
 *
 * ```ts
 * import nacl from "tweetnacl";
 * const signer = keypairSigner(keypair, nacl.sign.detached);
 * ```
 */
export function keypairSigner(
  keypair: KeypairLike,
  sign: (message: Uint8Array, secretKey: Uint8Array) => Uint8Array,
): PerpSigner {
  return {
    publicKey: keypair.publicKey,
    async signMessage(message: Uint8Array): Promise<Uint8Array> {
      return sign(message, keypair.secretKey);
    },
  };
}

/**
 * Reads a Solana CLI keypair file — a JSON array of 64 secret-key bytes.
 *
 * The file is a live private key: keep it out of source control, out of logs,
 * and out of any request. Returns raw bytes; build a `Keypair` with
 * `Keypair.fromSecretKey(...)` if you also need to sign transactions.
 */
export function readKeypairFile(path: string): Uint8Array {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new PerpUsageError(`could not read keypair file at ${path}`, { cause });
  }
  if (!Array.isArray(parsed) || parsed.length !== 64) {
    throw new PerpUsageError(
      `${path} is not a Solana CLI keypair file (expected a JSON array of 64 bytes)`,
    );
  }
  return Uint8Array.from(parsed as number[]);
}

import { PerpUsageError } from "./errors.js";
import type { RequestId } from "./types.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Generates a canonical lowercase UUID for a new trading intent.
 *
 * `crypto.randomUUID` exists in browsers (secure contexts) and Node 19+. The
 * fallback uses `crypto.getRandomValues`, which is available everywhere the SDK
 * runs; there is deliberately no `Math.random` path, because a collision here
 * means one intent silently replaying another.
 */
export function newRequestId(): RequestId {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === "function") {
    return webCrypto.randomUUID();
  }
  if (typeof webCrypto?.getRandomValues !== "function") {
    throw new PerpUsageError(
      "no Web Crypto available to generate a request_id; pass one explicitly",
    );
  }
  const bytes = webCrypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function assertRequestId(value: string): RequestId {
  if (!UUID_PATTERN.test(value)) {
    throw new PerpUsageError(
      `request_id must be canonical lowercase UUID text, received ${JSON.stringify(value)}`,
    );
  }
  return value;
}

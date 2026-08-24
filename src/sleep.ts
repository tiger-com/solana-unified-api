import { PerpTransportError } from "./errors.js";

/** Promise-based delay that rejects if `signal` aborts first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new PerpTransportError("request aborted"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new PerpTransportError("request aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Full-jitter backoff. Randomising the whole interval — rather than adding
 * jitter to a fixed delay — is what stops many clients from retrying in step
 * after a shared dependency recovers.
 */
export const backoffMs = (attempt: number, baseMs: number, capMs: number): number =>
  Math.random() * Math.min(capMs, baseMs * 2 ** attempt);

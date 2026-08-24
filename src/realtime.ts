/**
 * Live account-scoped executions and position events over WebSocket.
 *
 * Transport is Centrifugo. The connection token is short-lived and is not
 * refreshed by the transport, so this module mints a new one on every
 * reconnect through the client's `getToken` callback.
 */
import { Centrifuge, type Subscription } from "centrifuge";

import type { PerpClient } from "./client.js";
import { PerpUsageError } from "./errors.js";
import type { ExecutionEvent, PositionEvent } from "./types.js";

export type RealtimePublication =
  | { record: "OwnerPerpetualExecutionV1"; data: ExecutionEvent }
  | { record: "OwnerPerpetualPositionV1"; data: PositionEvent };

export interface RealtimeHandlers {
  onExecution?: (event: ExecutionEvent) => void;
  onPosition?: (event: PositionEvent) => void;
  /** Any publication, including record types this SDK version does not model. */
  onPublication?: (publication: RealtimePublication) => void;
  onConnected?: (context: { channel: string }) => void;
  onDisconnected?: (context: { reason: string }) => void;
  onError?: (error: unknown) => void;
}

export interface RealtimeOptions extends RealtimeHandlers {
  /**
   * How many recent event identities to remember for deduplication.
   *
   * Delivery is at-least-once, so a redelivery must not be counted twice. The
   * window is bounded because the stream is unbounded; 10 000 covers far more
   * than any realistic redelivery gap.
   */
  dedupeWindow?: number;
  /** Overrides the WebSocket endpoint from the client's environment. */
  websocketUrl?: string;
}

/**
 * Bounded set that evicts oldest-first.
 *
 * A plain `Set` would grow without limit on a long-lived connection.
 */
class RecentKeys {
  readonly #keys = new Set<string>();
  readonly #limit: number;

  constructor(limit: number) {
    this.#limit = limit;
  }

  /** Records `key` and reports whether it had already been seen. */
  seen(key: string): boolean {
    if (this.#keys.has(key)) return true;
    this.#keys.add(key);
    if (this.#keys.size > this.#limit) {
      const oldest = this.#keys.values().next();
      if (!oldest.done) this.#keys.delete(oldest.value);
    }
    return false;
  }
}

/** A live subscription to the wallet's private event channel. */
export class RealtimeStream {
  readonly #centrifuge: Centrifuge;
  readonly #subscription: Subscription;
  readonly channel: string;

  constructor(centrifuge: Centrifuge, subscription: Subscription, channel: string) {
    this.#centrifuge = centrifuge;
    this.#subscription = subscription;
    this.channel = channel;
  }

  /** Closes the subscription and the underlying connection. */
  close(): void {
    this.#subscription.unsubscribe();
    this.#centrifuge.disconnect();
  }

  /** Underlying Centrifugo objects, for advanced use. */
  get transport(): { centrifuge: Centrifuge; subscription: Subscription } {
    return { centrifuge: this.#centrifuge, subscription: this.#subscription };
  }
}

const isPublication = (value: unknown): value is RealtimePublication =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { record?: unknown }).record === "string" &&
  typeof (value as { data?: unknown }).data === "object";

/**
 * Connects and subscribes to the authenticated wallet's private channel.
 *
 * Executions are deduplicated by `source_key` and position events by
 * `event_id`, because delivery is at-least-once.
 *
 * The stream is live-only: connecting replays nothing, and an accepted
 * publication does not prove any client was online. Backfill fills from
 * `client.history.ledger(...)` — the same `source_key` appears on both sides,
 * so the two reconcile by exact string equality.
 */
export async function subscribeEvents(
  client: PerpClient,
  options: RealtimeOptions = {},
): Promise<RealtimeStream> {
  const endpoint = options.websocketUrl ?? client.endpoints.websocket;
  if (!endpoint) {
    throw new PerpUsageError("no websocket endpoint configured for this environment");
  }

  const initial = await client.realtimeToken();

  const centrifuge = new Centrifuge(endpoint, {
    token: initial.token,
    // Every reconnect needs a freshly minted token; the old one is short-lived.
    getToken: async () => (await client.realtimeToken()).token,
  });

  const executions = new RecentKeys(options.dedupeWindow ?? 10_000);
  const positions = new RecentKeys(options.dedupeWindow ?? 10_000);

  const subscription = centrifuge.newSubscription(initial.channel);

  subscription.on("publication", (context) => {
    const payload: unknown = context.data;
    if (!isPublication(payload)) return;

    try {
      options.onPublication?.(payload);

      if (payload.record === "OwnerPerpetualExecutionV1") {
        if (executions.seen(payload.data.source_key)) return;
        options.onExecution?.(payload.data);
        return;
      }
      if (payload.record === "OwnerPerpetualPositionV1") {
        if (positions.seen(payload.data.event_id)) return;
        options.onPosition?.(payload.data);
      }
    } catch (error) {
      // A throwing handler must not tear down the transport.
      options.onError?.(error);
    }
  });

  subscription.on("error", (context) => options.onError?.(context.error));
  centrifuge.on("error", (context) => options.onError?.(context.error));
  centrifuge.on("connected", () => options.onConnected?.({ channel: initial.channel }));
  centrifuge.on("disconnected", (context) =>
    options.onDisconnected?.({ reason: context.reason }),
  );

  subscription.subscribe();
  centrifuge.connect();

  return new RealtimeStream(centrifuge, subscription, initial.channel);
}

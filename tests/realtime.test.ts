import { describe, expect, it, vi } from "vitest";

type Handler = (context: unknown) => void;

const subscriptions: Array<{ channel: string; handlers: Map<string, Handler> }> = [];

vi.mock("centrifuge", () => {
  class FakeSubscription {
    readonly handlers = new Map<string, Handler>();
    constructor(readonly channel: string) {}
    on(event: string, handler: Handler) {
      this.handlers.set(event, handler);
      return this;
    }
    subscribe() {}
    unsubscribe() {}
  }
  class Centrifuge {
    constructor(
      readonly url: string,
      readonly options: { token: string; getToken: () => Promise<string> },
    ) {}
    on() {
      return this;
    }
    connect() {}
    disconnect() {}
    newSubscription(channel: string) {
      const subscription = new FakeSubscription(channel);
      subscriptions.push(subscription);
      return subscription;
    }
  }
  return { Centrifuge, Subscription: FakeSubscription };
});

const { subscribeEvents } = await import("../src/realtime.js");
const { PerpClient } = await import("../src/client.js");
const { challengeResponse, stubFetch, stubSigner, tokenResponse } = await import("./helpers.js");

const execution = (sourceKey: string) => ({
  record: "OwnerPerpetualExecutionV1",
  data: { source_key: sourceKey, quantity: "1" },
});

const position = (eventId: string) => ({
  record: "OwnerPerpetualPositionV1",
  data: { event_id: eventId, realized_pnl: "1" },
});

async function connect(options = {}) {
  subscriptions.length = 0;
  const { fetch } = stubFetch([
    { body: challengeResponse },
    { body: tokenResponse() },
    { body: { token: "ws-token", channel: "perpetual:events#owner" } },
  ]);
  const client = new PerpClient({ signer: stubSigner(), fetch, rateLimit: null });
  const executions: unknown[] = [];
  const positions: unknown[] = [];
  const stream = await subscribeEvents(client, {
    onExecution: (event) => executions.push(event),
    onPosition: (event) => positions.push(event),
    ...options,
  });
  const publish = (payload: unknown) =>
    subscriptions[0]!.handlers.get("publication")?.({ data: payload });
  return { stream, publish, executions, positions };
}

describe("subscribeEvents", () => {
  it("subscribes to the channel the API returned", async () => {
    const { stream } = await connect();
    expect(stream.channel).toBe("perpetual:events#owner");
    expect(subscriptions[0]!.channel).toBe("perpetual:events#owner");
  });

  it("deduplicates executions by source_key", async () => {
    const { publish, executions } = await connect();

    publish(execution("a"));
    publish(execution("a")); // at-least-once redelivery
    publish(execution("b"));

    expect(executions).toHaveLength(2);
  });

  it("deduplicates position events by event_id, independently of executions", async () => {
    const { publish, executions, positions } = await connect();

    publish(position("a"));
    publish(position("a"));
    publish(execution("a")); // same string, different identity space

    expect(positions).toHaveLength(1);
    expect(executions).toHaveLength(1);
  });

  it("ignores record types it does not model", async () => {
    const { publish, executions, positions } = await connect();
    publish({ record: "SomeFutureRecordV2", data: { id: "x" } });
    expect(executions).toHaveLength(0);
    expect(positions).toHaveLength(0);
  });

  it("keeps the transport alive when a handler throws", async () => {
    const errors: unknown[] = [];
    const { publish, executions } = await connect({
      onExecution: () => {
        throw new Error("handler bug");
      },
      onError: (error: unknown) => errors.push(error),
    });

    publish(execution("a"));
    publish(execution("b"));

    expect(errors).toHaveLength(2);
    expect(executions).toHaveLength(0);
  });

  it("bounds the dedupe window so a long connection cannot leak memory", async () => {
    const { publish, executions } = await connect({ dedupeWindow: 2 });

    publish(execution("a"));
    publish(execution("b"));
    publish(execution("c")); // evicts "a"
    publish(execution("a")); // no longer remembered, so it is delivered again

    expect(executions).toHaveLength(4);
  });
});

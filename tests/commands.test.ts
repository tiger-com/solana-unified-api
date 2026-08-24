import { describe, expect, it } from "vitest";

import { PerpClient } from "../src/client.js";
import { challengeResponse, stubFetch, stubSigner, tokenResponse } from "./helpers.js";

const command = (state: string) => ({
  command: {
    id: 1,
    request_id: "9f1d5f7a-1c2b-4a3e-8f10-0b3d5c7e9a11",
    kind: "PLACE_ORDER",
    payload: {},
    state,
    created_at: "2026-08-24T10:00:00Z",
    updated_at: "2026-08-24T10:00:00Z",
  },
});

const build = (script: Parameters<typeof stubFetch>[0]) => {
  const { fetch, calls } = stubFetch([
    { body: challengeResponse },
    { body: tokenResponse() },
    ...script,
  ]);
  return {
    calls,
    client: new PerpClient({ signer: stubSigner(), fetch, rateLimit: null, retry: { maxRetries: 0 } }),
  };
};

describe("waitForTerminal", () => {
  it("polls until the command settles", async () => {
    const { client, calls } = build([
      { body: command("QUEUED") },
      { body: command("SUBMITTED") },
      { body: command("COMPLETED") },
    ]);

    const settled = await client.commands.waitForTerminal("PHX", "acct", "9f1d5f7a-1c2b-4a3e-8f10-0b3d5c7e9a11", {
      pollIntervalMs: 1,
    });

    expect(settled.state).toBe("COMPLETED");
    expect(calls.filter((call) => call.url.includes("/commands/"))).toHaveLength(3);
  });

  it("reports every state change once", async () => {
    const { client } = build([
      { body: command("QUEUED") },
      { body: command("QUEUED") },
      { body: command("SUBMITTED") },
      { body: command("FAILED") },
    ]);

    const seen: string[] = [];
    await client.commands.waitForTerminal("PHX", "acct", "9f1d5f7a-1c2b-4a3e-8f10-0b3d5c7e9a11", {
      pollIntervalMs: 1,
      onState: (observed) => seen.push(observed.state),
    });

    expect(seen).toEqual(["QUEUED", "SUBMITTED", "FAILED"]);
  });

  it("treats FAILED as terminal rather than an error", async () => {
    const { client } = build([{ body: command("FAILED") }]);
    const settled = await client.commands.waitForTerminal("PHX", "acct", "9f1d5f7a-1c2b-4a3e-8f10-0b3d5c7e9a11");
    expect(settled.state).toBe("FAILED");
  });

  it("says the command is still live when the wait times out", async () => {
    const { client } = build([{ body: command("SUBMITTED") }]);
    await expect(
      client.commands.waitForTerminal("PHX", "acct", "9f1d5f7a-1c2b-4a3e-8f10-0b3d5c7e9a11", {
        pollIntervalMs: 5,
        timeoutMs: 1,
      }),
    ).rejects.toThrow(/do not resend the intent/);
  });
});

describe("pending", () => {
  it("pages through every non-terminal command", async () => {
    const { client, calls } = build([
      { body: { commands: [command("QUEUED").command], has_more: true, next_cursor: "1" } },
      { body: { commands: [command("SUBMITTED").command], has_more: false, next_cursor: "" } },
    ]);

    const pending = await client.commands.pending("PHX", "acct");

    expect(pending.map((entry) => entry.state)).toEqual(["QUEUED", "SUBMITTED"]);
    expect(calls.at(-1)!.url).toContain("cursor=1");
    expect(calls.at(-1)!.url).toContain("terminal=false");
  });
});

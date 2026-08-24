import { API_PREFIX } from "../config.js";
import { PerpUsageError } from "../errors.js";
import type { HttpClient } from "../http.js";
import { sleep } from "../sleep.js";
import { isTerminalCommandState, type Command, type CommandsPage, type Venue } from "../types.js";

export interface CommandListOptions {
  /** 1–100; the API defaults to 50. */
  limit?: number;
  /** Non-negative decimal command `id`. Omit for the first page. */
  cursor?: string;
  /** `false` (default) non-terminal, `true` terminal, `"all"` both. */
  terminal?: boolean | "all";
  signal?: AbortSignal;
}

export interface WaitOptions {
  /** Delay between polls. Defaults to 500 ms. */
  pollIntervalMs?: number;
  /** Gives up after this long. Defaults to 60 s. The command keeps running. */
  timeoutMs?: number;
  /** Called on every observed state change. */
  onState?: (command: Command) => void;
  signal?: AbortSignal;
}

const commandsPath = (venue: Venue, nativeAccount: string): string =>
  `${API_PREFIX}/venues/${encodeURIComponent(venue)}` +
  `/accounts/${encodeURIComponent(nativeAccount)}/commands`;

/**
 * Reads durable command state.
 *
 * This is the correct response to any uncertainty about a trading call — a
 * timeout, a `502 submission_unknown`, a `503 transaction_not_submitted`, or a
 * process restart. Poll the original `request_id`; never issue a replacement
 * intent while a command is non-terminal.
 */
export class CommandsResource {
  constructor(private readonly http: HttpClient) {}

  /** One command by its client idempotency key. */
  async get(
    venue: Venue,
    nativeAccount: string,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<Command> {
    const body = await this.http.request<{ command: Command }>({
      method: "GET",
      path: `${commandsPath(venue, nativeAccount)}/${encodeURIComponent(requestId)}`,
      idempotent: true,
      signal,
    });
    return body.command;
  }

  /** One page of commands, oldest first. */
  list(
    venue: Venue,
    nativeAccount: string,
    options: CommandListOptions = {},
  ): Promise<CommandsPage> {
    return this.http.request<CommandsPage>({
      method: "GET",
      path: commandsPath(venue, nativeAccount),
      query: {
        limit: options.limit,
        cursor: options.cursor,
        terminal: options.terminal === undefined ? undefined : String(options.terminal),
      },
      idempotent: true,
      signal: options.signal,
    });
  }

  /** Walks every command page, oldest first. */
  async *iterate(
    venue: Venue,
    nativeAccount: string,
    options: CommandListOptions = {},
  ): AsyncGenerator<Command> {
    let cursor = options.cursor;
    for (;;) {
      const page = await this.list(venue, nativeAccount, { ...options, cursor });
      yield* page.commands;
      if (!page.has_more || !page.next_cursor) return;
      cursor = page.next_cursor;
    }
  }

  /**
   * Every command that has not reached a terminal state.
   *
   * Run this on startup: it is how a restarted process rediscovers intents it
   * sent but never saw settle, without inventing new ones.
   */
  async pending(venue: Venue, nativeAccount: string, signal?: AbortSignal): Promise<Command[]> {
    const pending: Command[] = [];
    for await (const command of this.iterate(venue, nativeAccount, { terminal: false, signal })) {
      pending.push(command);
    }
    return pending;
  }

  /**
   * Polls one command until it reaches a terminal state.
   *
   * A timeout here means "stopped watching", not "failed" — the command is
   * still live on the server. Resume by calling this again with the same
   * `request_id`.
   */
  async waitForTerminal(
    venue: Venue,
    nativeAccount: string,
    requestId: string,
    options: WaitOptions = {},
  ): Promise<Command> {
    const interval = options.pollIntervalMs ?? 500;
    const deadline = Date.now() + (options.timeoutMs ?? 60_000);
    let previousState: string | undefined;

    for (;;) {
      const command = await this.get(venue, nativeAccount, requestId, options.signal);
      if (command.state !== previousState) {
        previousState = command.state;
        options.onState?.(command);
      }
      if (isTerminalCommandState(command.state)) return command;

      if (Date.now() + interval > deadline) {
        throw new PerpUsageError(
          `command ${requestId} is still ${command.state} after the wait timeout; ` +
            `it remains live — poll the same request_id, do not resend the intent`,
        );
      }
      await sleep(interval, options.signal);
    }
  }
}

import type { PerpClient } from "./client.js";
import type { CommandListOptions, WaitOptions } from "./resources/commands.js";
import type { PageOptions } from "./resources/history.js";
import type { IntentOptions } from "./resources/trading.js";
import type {
  Account,
  AccountSnapshot,
  AccountSetup,
  AccountWithState,
  CancelOrdersRequest,
  Command,
  CommandEnvelope,
  CommandsPage,
  CollateralTransaction,
  Decimal,
  FillsPage,
  LedgerPage,
  LifecycleResult,
  OrderPurpose,
  OrdersPage,
  PlaceOrderRequest,
  ReducePositionRequest,
  SetProtectionRequest,
  Venue,
  WithoutRequestId,
} from "./types.js";

/**
 * An admitted command, plus a bound way to follow it.
 *
 * `wait()` is deliberately not implicit: a `202` means the intent is durable,
 * not that it executed, and hiding the difference is what leads callers to
 * treat a slow poll as a failure and resend.
 */
export interface SubmittedCommand extends CommandEnvelope {
  /** Polls this command's `request_id` until it reaches a terminal state. */
  wait(options?: WaitOptions): Promise<Command>;
}

/**
 * A client bound to one `(venue, native_account)` pair.
 *
 * The API identifies an account by that pair, and a wallet may own several
 * native accounts on one venue, so the identity cannot be inferred. Binding it
 * once removes the repetition — and removes a real hazard, since `venue` and
 * `native_account` are both plain strings that a type checker cannot tell apart
 * if they are swapped.
 *
 * ```ts
 * const [found] = await client.accounts.list({ venue: "PHX" });
 * const account = client.account(found);
 *
 * const state = await account.freshState();
 * const order = await account.place({ ... });
 * await order.wait();
 * ```
 *
 * Every method here forwards to the same resource it wraps, so the
 * `client.trading.place(venue, native, ...)` form remains available for code
 * that juggles several accounts at once.
 */
export class AccountHandle {
  readonly #client: PerpClient;

  constructor(
    client: PerpClient,
    readonly venue: Venue,
    readonly nativeAccount: string,
  ) {
    this.#client = client;
  }

  /** The `(venue, native_account)` pair this handle is bound to. */
  get id(): { venue: Venue; native_account: string } {
    return { venue: this.venue, native_account: this.nativeAccount };
  }

  /* ------------------------------------------------------------------ state */

  /** Account identity, plus live state when the status admits it. */
  get(signal?: AbortSignal): Promise<AccountWithState> {
    return this.#client.accounts.get(this.venue, this.nativeAccount, signal);
  }

  /** A snapshot fresh enough to fingerprint a `reduce` or `protection` command. */
  freshState(options?: { attempts?: number; signal?: AbortSignal }): Promise<AccountSnapshot> {
    return this.#client.freshState(this.venue, this.nativeAccount, options);
  }

  /* -------------------------------------------------------------- lifecycle */

  /** Moves an ACTIVE account to PAUSED. Not idempotent. */
  disable(signal?: AbortSignal): Promise<Account> {
    return this.#client.accounts.disable(this.venue, this.nativeAccount, signal);
  }

  /** Re-enables an eligible PAUSED account. Not idempotent. */
  enable(signal?: AbortSignal): Promise<Account> {
    return this.#client.accounts.enable(this.venue, this.nativeAccount, signal);
  }

  /** Builds owner-signed delegate revocation. Requires PAUSED. */
  revoke(signal?: AbortSignal): Promise<AccountSetup> {
    return this.#client.accounts.revoke(this.venue, this.nativeAccount, signal);
  }

  continueSetup(
    step?: { setup_step_id: string; signed_transaction: string },
    signal?: AbortSignal,
  ): Promise<AccountSetup> {
    return this.#client.accounts.continueSetup(this.venue, this.nativeAccount, step, signal);
  }

  confirmSetup(
    proof: { setup_step_id: string; signature: string },
    signal?: AbortSignal,
  ): Promise<LifecycleResult> {
    return this.#client.accounts.confirmSetup(this.venue, this.nativeAccount, proof, signal);
  }

  confirmRevocation(
    proof: { setup_step_id: string; signature: string },
    signal?: AbortSignal,
  ): Promise<LifecycleResult> {
    return this.#client.accounts.confirmRevocation(this.venue, this.nativeAccount, proof, signal);
  }

  /* ------------------------------------------------------------- collateral */

  /** Builds an owner-signed deposit. You still sign and submit it yourself. */
  deposit(amount: Decimal, signal?: AbortSignal): Promise<CollateralTransaction> {
    return this.#client.collateral.deposit(this.venue, this.nativeAccount, amount, signal);
  }

  /** Builds an owner-signed withdrawal. */
  withdraw(amount: Decimal, signal?: AbortSignal): Promise<CollateralTransaction> {
    return this.#client.collateral.withdraw(this.venue, this.nativeAccount, amount, signal);
  }

  /* ---------------------------------------------------------------- trading */

  /** Current venue orders plus the snapshot they were read from. */
  orders(options: {
    marketId?: string;
    purpose?: OrderPurpose;
    signal?: AbortSignal;
  } = {}): Promise<OrdersPage> {
    return this.#client.trading.orders(this.venue, this.nativeAccount, options);
  }

  /** Places one order and returns the admitted command. */
  place(
    order: WithoutRequestId<PlaceOrderRequest>,
    options: IntentOptions = {},
  ): Promise<SubmittedCommand> {
    return this.#track(this.#client.trading.place(this.venue, this.nativeAccount, order, options));
  }

  /** Cancels selected orders, or every order in one market. */
  cancel(
    request: WithoutRequestId<CancelOrdersRequest>,
    options: IntentOptions = {},
  ): Promise<SubmittedCommand> {
    return this.#track(
      this.#client.trading.cancel(this.venue, this.nativeAccount, request, options),
    );
  }

  /** Clears every current order in one market. */
  cancelAll(marketId: string, options: IntentOptions = {}): Promise<SubmittedCommand> {
    return this.cancel({ market_id: marketId, cancel_all: true }, options);
  }

  /** Reduces the current position in one market. Needs a fresh fingerprint. */
  reduce(
    marketId: string,
    request: WithoutRequestId<ReducePositionRequest>,
    options: IntentOptions = {},
  ): Promise<SubmittedCommand> {
    return this.#track(
      this.#client.trading.reduce(this.venue, this.nativeAccount, marketId, request, options),
    );
  }

  /** Sets native take-profit and stop-loss. Needs a fresh fingerprint. */
  setProtection(
    marketId: string,
    request: WithoutRequestId<SetProtectionRequest>,
    options: IntentOptions = {},
  ): Promise<SubmittedCommand> {
    return this.#track(
      this.#client.trading.setProtection(this.venue, this.nativeAccount, marketId, request, options),
    );
  }

  /* --------------------------------------------------------------- commands */

  /** One command by its client idempotency key. */
  command(requestId: string, signal?: AbortSignal): Promise<Command> {
    return this.#client.commands.get(this.venue, this.nativeAccount, requestId, signal);
  }

  /** One page of commands, oldest first. */
  commands(options: CommandListOptions = {}): Promise<CommandsPage> {
    return this.#client.commands.list(this.venue, this.nativeAccount, options);
  }

  /** Every command that has not reached a terminal state. */
  pendingCommands(signal?: AbortSignal): Promise<Command[]> {
    return this.#client.commands.pending(this.venue, this.nativeAccount, signal);
  }

  /** Polls one command until it settles. */
  waitFor(requestId: string, options: WaitOptions = {}): Promise<Command> {
    return this.#client.commands.waitForTerminal(this.venue, this.nativeAccount, requestId, options);
  }

  /* ---------------------------------------------------------------- history */

  fills(options: PageOptions = {}): Promise<FillsPage> {
    return this.#client.history.fills(this.venue, this.nativeAccount, options);
  }

  ledger(options: PageOptions = {}): Promise<LedgerPage> {
    return this.#client.history.ledger(this.venue, this.nativeAccount, options);
  }

  iterateFills(options: PageOptions = {}): AsyncGenerator<FillsPage["fills"][number]> {
    return this.#client.history.iterateFills(this.venue, this.nativeAccount, options);
  }

  iterateLedger(options: PageOptions = {}): AsyncGenerator<LedgerPage["events"][number]> {
    return this.#client.history.iterateLedger(this.venue, this.nativeAccount, options);
  }

  /** Attaches a bound `wait()` to an admitted command. */
  async #track(pending: Promise<CommandEnvelope>): Promise<SubmittedCommand> {
    const envelope = await pending;
    return {
      ...envelope,
      wait: (options?: WaitOptions) => this.waitFor(envelope.command.request_id, options),
    };
  }
}

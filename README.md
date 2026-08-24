# @tigercom/perp-sdk

[![CI](https://github.com/tiger-com/solana-unified-api/actions/workflows/ci.yml/badge.svg)](https://github.com/tiger-com/solana-unified-api/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@tigercom/perp-sdk.svg)](https://www.npmjs.com/package/@tigercom/perp-sdk)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

TypeScript client for the Tiger Solana unified perpetuals API — one REST contract for
trading perpetual futures across Solana venues. One package for Node and the browser.

🧩 [Examples](./examples) · 📋 [Changelog](CHANGELOG.md) · 📄 [OpenAPI description](spec/openapi.yaml)

<!-- TODO: link the hosted API reference once it has a public URL. -->

```bash
npm install @tigercom/perp-sdk
```

`@solana/web3.js` is an optional peer dependency, needed only for onboarding,
collateral, and revocation:

```bash
npm install @solana/web3.js
```

## Quick start

```ts
import { PerpClient } from "@tigercom/perp-sdk";

const client = new PerpClient({ environment: "development", signer });

const markets = await client.discovery.markets("PHX");
const [found] = await client.accounts.list({ venue: "PHX" });
const account = client.account(found);

const order = await account.place({
  market_id: markets[0].market_id,
  side: "B",
  kind: "MARKET",
  execution_mode: "IOC",
  quantity: "0.01",
  max_slippage_bps: 100,
});

const settled = await order.wait();
```

### Account handles

The API identifies an account by `(venue, native_account)`, and a wallet may own
several native accounts on one venue — so the pair cannot be inferred. It can,
however, be bound once:

```ts
const account = client.account(found);          // or client.account("PHX", native)

await account.freshState();
await account.orders({ marketId });
await account.cancelAll(marketId);
await account.deposit("25");

for (const handle of await client.accountHandles({ venue: "PHX" })) { /* … */ }
```

Binding removes more than typing: `venue` and `native_account` are both plain
strings, so transposing them is a mistake no type checker can catch.

Every handle method forwards to the resource it wraps, and the resource form
stays available for code that works across several accounts at once:

```ts
await client.trading.place(venue, nativeAccount, order);
```

`place`, `cancel`, `reduce`, and `setProtection` return the admitted command
with a bound `wait()`. Waiting stays explicit — a `202` means the intent is
durable, not that it executed, and hiding that is what leads callers to treat a
slow poll as a failure and resend:

```ts
const order = await account.place({ … });
console.log(order.command.state);   // "QUEUED"
const settled = await order.wait(); // "COMPLETED" | "FAILED" | …
```

## Examples

Every file in [`examples/`](./examples) is runnable and type-checked against this
source, so nothing here can drift from the API.

| Example | What it shows |
| --- | --- |
| [`quickstart.ts`](./examples/quickstart.ts) | Login, discovery, a market order, and following it to a terminal state. |
| [`market-data.ts`](./examples/market-data.ts) | The order book and trade tape — public routes that need no wallet. |
| [`limit-orders.ts`](./examples/limit-orders.ts) | Post-only resting orders, and why an accepted command is not a resting order. |
| [`close-position.ts`](./examples/close-position.ts) | Partial reduce and full close, with the snapshot fingerprint and `stale_state` recovery. |
| [`protection.ts`](./examples/protection.ts) | Take-profit and stop-loss as native position state, and reading back what is armed. |
| [`stop-entry.ts`](./examples/stop-entry.ts) | Stop-market entries, gated on a capability that genuinely differs by venue. |
| [`replace-order.ts`](./examples/replace-order.ts) | Repricing without an amend endpoint: cancel, settle, re-place the unfilled remainder. |
| [`portfolio.ts`](./examples/portfolio.ts) | Margin, PnL, and the funding arithmetic that is easy to double-count. |
| [`resume-after-restart.ts`](./examples/resume-after-restart.ts) | Reconciling in-flight intents before submitting anything new. |
| [`onboarding.ts`](./examples/onboarding.ts) | Wallet to `ACTIVE` account, then a collateral deposit. |
| [`realtime.ts`](./examples/realtime.ts) | Streaming executions and backfilling the gap by `source_key`. |
| [`browser.tsx`](./examples/browser.tsx) | React with a wallet-adapter wallet. |

## Entry points

| Import | Contents | Extra dependency |
| --- | --- | --- |
| `@tigercom/perp-sdk` | Client, resources, types, decimal helpers | — |
| `@tigercom/perp-sdk/node` | Keypair signer, CLI keypair reader | `tweetnacl` (injected) |
| `@tigercom/perp-sdk/browser` | Wallet-adapter signer | — |
| `@tigercom/perp-sdk/solana` | Submit/confirm, onboarding and revocation drivers | `@solana/web3.js` |
| `@tigercom/perp-sdk/realtime` | Live executions and position events | bundled `centrifuge` |

The core entry imports neither `node:fs` nor `@solana/web3.js` nor `centrifuge`,
so a browser bundle stays small unless you reach for a subpath.

## Signing

Anything with a public key and `signMessage` works — a wallet-adapter wallet
satisfies it directly:

```ts
import { walletAdapterSigner } from "@tigercom/perp-sdk/browser";
const signer = walletAdapterSigner(wallet);
```

```ts
import nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import { keypairSigner, readKeypairFile } from "@tigercom/perp-sdk/node";

const keypair = Keypair.fromSecretKey(readKeypairFile(process.env.SOLANA_KEYPAIR_PATH!));
const signer = keypairSigner(keypair, nacl.sign.detached);
```

The wallet signs four things: the login challenge, onboarding transactions, the
revocation transaction, and every collateral transfer. **Orders are not among
them** — trading runs through a Tiger-managed delegate, so placing an order is
an authenticated REST call, not a wallet prompt.

## What the SDK handles for you

**Sessions.** Authentication is lazy and single-flight: ten concurrent calls on
an expired token produce one wallet prompt, not ten. Tokens are renewed a minute
before expiry so the popup lands between trades rather than during one. Tokens
live in memory by default; pass a `tokenStore` to change that, but do not put a
token in `localStorage` — anything that can run script on the page can read it,
and the API has no revocation.

**Idempotency.** Every trading call carries a `request_id`. The SDK generates
one per intent, or resolves a stable `intentKey` through an `IdempotencyStore`:

```ts
// The same key always maps to the same request_id, so a resend replays
// rather than placing a second order.
await client.trading.place("PHX", native, order, { intentKey: "rebalance-2026-08-24" });
```

**Durable commands.** A `202` means the intent is stored, not that it executed.
`502` and `503` responses still carry the command, and the SDK surfaces them as
`PerpCommandError` **without retrying**:

```ts
catch (error) {
  if (isCommandError(error)) {
    await client.commands.waitForTerminal("PHX", native, error.command.request_id);
  }
}
```

Never issue a new `request_id` because polling was slow. `client.commands.pending()`
recovers in-flight intents after a restart.

**Retries and rate limits.** Retryable failures are retried with full jitter,
honouring `Retry-After`. Non-idempotent routes (`disable`, `enable`) are never
replayed after a transport failure. Requests are shaped to the documented 5
reads and 5 writes per second per wallet, so a burst waits instead of returning
`429`. Both are configurable; pass `rateLimit: null` to opt out.

**Exact decimals.** Money, prices, and quantities are strings end to end. The
SDK never parses one into a `number`:

```ts
import { decimal, alignQuantity, validateOrder } from "@tigercom/perp-sdk";

const quantity = alignQuantity(market, "0.0179");   // "0.017", rounded toward zero
validateOrder(market, { quantity, price: "184.20" }); // throws before spending a request
decimal.add("0.1", "0.2");                           // "0.3"
```

Pass `{ market }` to `trading.place` and validation runs automatically.

**Snapshot freshness.** `reduce` and `setProtection` need a fingerprint from a
non-stale snapshot. `client.freshState(...)` retries past a stale fallback
instead of letting one reach the venue.

## Market data

Two public routes need no wallet, so a read-only integration never authenticates:

```ts
const book = await client.discovery.orderbook("PHX", marketId, { depth: 20 });
const tape = await client.discovery.trades("PHX", marketId, { limit: 100 });

for await (const trade of client.discovery.iterateTrades("PHX", marketId)) { /* … */ }
```

Gate them on `capabilities.orderbook` and `capabilities.market_trades`. They carry no
account attribution — the book is aggregated by price and the tape is the whole market —
so read your own activity through `trading.orders`, `history.fills`, and the ledger.

Public market data is rate limited separately from wallet traffic, at roughly five
requests per second. The client limiter shapes bursts to fit rather than returning `429`.

## Realtime

```ts
import { subscribeEvents } from "@tigercom/perp-sdk/realtime";

const stream = await subscribeEvents(client, {
  onExecution: (event) => console.log(event.market.symbol, event.quantity, event.price),
  onPosition: (event) => console.log(event.market.symbol, event.realized_pnl),
});
```

Connection tokens are short-lived, so a fresh one is minted on every reconnect.
Delivery is at-least-once: executions are deduplicated by `source_key` and
position events by `event_id`, in a bounded window so a long-lived connection
cannot leak memory.

The stream is live-only — connecting replays nothing, and there is no durable
replay for position events. Ledger fills carry the same `source_key` as their
execution event, so subscribe first and then backfill; see
[`examples/realtime.ts`](./examples/realtime.ts).

## Errors

Every failure is a subclass of `PerpError`, and `error.code` is the stable
contract — never branch on `message`.

| Class | Meaning |
| --- | --- |
| `PerpApiError` | The API returned an error envelope. Carries `status`, `code`, `retryAfterSeconds`. |
| `PerpCommandError` | The intent is durable despite the failure. Poll `error.command`. |
| `PerpAuthError` | No usable session, or `onAuthRequired` declined. |
| `PerpTransportError` | Network failure, timeout, or a non-JSON response. |
| `PerpUsageError` | A precondition the SDK checked before spending a request. |

```ts
import { hasErrorCode } from "@tigercom/perp-sdk";
if (hasErrorCode(error, "stale_state")) { /* re-read state, submit a new intent */ }
```

## Environments

```ts
new PerpClient({ environment: "development", signer });
```

Production endpoints are not published yet, so `environment: "production"`
throws until you supply them:

```ts
new PerpClient({
  environment: "production",
  endpoints: { core: "…", ledger: "…", websocket: "…" },
  signer,
});
```

CORS is open: the API echoes the requesting origin and allows `Authorization`, so a
browser client works from any origin. Keep the access token in memory — a token in
`localStorage` is readable by anything that can run script on the page, and this API
has no token revocation.

## Types and the contract

[`spec/openapi.yaml`](spec/openapi.yaml) ships inside this repository *and* inside the
published package. It is the single source of truth: every type in `src/generated/` is
produced from it, so the SDK cannot describe a contract the spec does not.

```bash
npm run generate    # spec/openapi.yaml → src/generated/openapi.ts
npm run lint:spec   # validate the description itself
```

CI regenerates and fails if the committed output is stale, which is what keeps the two in
step. Since the spec is packaged, you can also generate a client for another language from
the copy inside `node_modules/@tigercom/perp-sdk/spec/`.

Responses are additive — unknown fields must be ignored, not rejected.

## Development

```bash
npm ci
npm run generate
npm run typecheck
npm run typecheck:examples   # examples are compiled, not decorative
npm test
npm run build
```

## Open items

- Production hosts are `TODO` until the ingress names are assigned.
- There is no test environment: this API is mainnet only. The suite runs against
  a stubbed transport, so no end-to-end run has been executed against a live
  deployment.
- Browser support is untested against a real browser, though CORS is confirmed open.
- `POST .../orders/preview` is deployed but its contract is unpublished, so the SDK does
  not wrap it. `capabilities.orders.preview` reports whether it is available.

## Security

Never put a private key, a keypair file, an access token, or a signed transaction into an
issue, a pull request, or a test fixture. This API issues no token revocation. See
[SECURITY.md](SECURITY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: `spec/openapi.yaml` is the
source of truth, and `src/generated/` is regenerated from it rather than edited.

## License

[MIT](LICENSE)

# Changelog

All notable changes to `@tigertrade/perp-sdk` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the version is below `1.0.0`, a minor bump may carry a breaking change; the entry
will say so.

## [Unreleased]

## [0.1.0] — 2026-08-24

First release. Types generated from `spec/openapi.yaml`, which ships with the package, and
verified against the development deployment.

### Added

- `PerpClient` covering discovery, wallet authentication, account lifecycle, collateral,
  trading, commands, and history.
- `client.account(...)` — a handle bound to one `(venue, native_account)` pair, so
  account-scoped calls drop both arguments. Commands it returns carry a bound `wait()`.
- Market data: `discovery.orderbook()`, `discovery.trades()`, and `iterateTrades()`.
- Realtime events at `@tigertrade/perp-sdk/realtime`, deduplicating executions by
  `source_key` and position events by `event_id` in a bounded window.
- Transaction helpers at `@tigertrade/perp-sdk/solana`: `submitAndConfirm`,
  `completeSetup`, and `completeRevocation`. `@solana/web3.js` is an optional peer
  dependency, and the caller supplies their own `Connection`.
- Signers for both runtimes: `walletAdapterSigner` in `/browser`, `keypairSigner` and
  `readKeypairFile` in `/node`.
- Exact decimal helpers under `decimal`, plus `alignQuantity`, `alignPrice`, and
  `validateOrder`, which reject a malformed order before it costs a request.
- Typed errors: `PerpApiError`, `PerpCommandError`, `PerpAuthError`, `PerpTransportError`,
  `PerpUsageError`, with `hasErrorCode` for branching on the stable `error.code`.
- Pluggable `TokenStore` and `IdempotencyStore`; both default to memory.

### Behaviour worth knowing

- Authentication is lazy and single-flight: concurrent calls on an expired token produce
  one wallet prompt, not one per call.
- Requests are shaped to the documented five reads and five writes per second per wallet,
  so a burst waits rather than returning `429`.
- `502` and `503` responses that carry a stored command raise `PerpCommandError` and are
  **not** retried — the command is durable and must be polled, never replaced.
- Transport failures are replayed only for idempotent requests; `disable` and `enable` are
  never replayed.
- The core entry imports neither `node:fs`, `@solana/web3.js`, nor `centrifuge`. CI
  enforces this.

[Unreleased]: https://github.com/tiger-com/solana-unified-api/compare/sdk-v0.1.0...HEAD
[0.1.0]: https://github.com/tiger-com/solana-unified-api/releases/tag/sdk-v0.1.0

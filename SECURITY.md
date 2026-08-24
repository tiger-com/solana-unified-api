# Security

## Reporting a vulnerability

Report privately through
[GitHub Security Advisories](https://github.com/tiger-com/solana-unified-api/security/advisories/new),
not through a public issue.

Please include what you did, what happened, and how severe you think it is. We will
acknowledge within three business days and keep you updated until it is resolved. If you
would like credit in the advisory, say so.

## Never put these in an issue, a PR, or a test fixture

- A wallet private key or a Solana CLI keypair file
- An access token issued by `POST /v1/perp/wallet/challenges/verify`
- A signed transaction's bytes
- An RPC endpoint that carries an API key in its URL

This API issues no revocation for access tokens. A token pasted into a public repository
stays valid until it expires, which is up to 24 hours.

## What this SDK does and does not touch

**It never sees your private key.** Signing happens behind the `PerpSigner` interface, in
your wallet or your own keypair handling. The SDK receives signatures, never secrets.

**It holds an access token in memory.** The default `TokenStore` is memory-only and
deliberately so: a token in `localStorage` is readable by anything that can run script on
the page.

**Trading commands are not signed by you.** After onboarding, orders execute through a
Tiger-managed delegate. That delegate can trade the account but cannot withdraw from it;
collateral movement always requires an owner signature. Revoking the delegate is
`accounts.disable` followed by `accounts.revoke`.

**Onboarding and collateral move real funds on Solana mainnet.** Treat any code path that
reaches `completeSetup`, `deposit`, or `withdraw` as a money-moving path.

## Scope

In scope: this SDK and the OpenAPI description it ships — for example a request built with
the wrong idempotency semantics, a token reaching a place it should not, or the description
understating a route's authorization.

Out of scope here: the deployed API and its infrastructure. Those reports go to Tiger
directly rather than through this repository.

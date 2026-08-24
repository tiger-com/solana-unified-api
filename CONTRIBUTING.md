# Contributing

## The one rule that explains the layout

`spec/openapi.yaml` is the single source of truth. The SDK's types are generated from it,
never hand-edited.

```
spec/openapi.yaml  →  src/generated/openapi.ts
```

`src/generated/` is committed on purpose, so anyone reading the repository sees the same
types they install. CI regenerates and fails if the committed copy is stale.

The spec also ships inside the published package, under `spec/`, so a consumer can generate
a client for another language from the exact contract these types were built from.

## Setup

```bash
npm ci
```

Node 20 or newer, as pinned in `.nvmrc`.

## Working on the SDK

```bash
npm run generate             # regenerate types after a spec change
npm run lint:spec            # validate the OpenAPI description
npm run typecheck
npm run typecheck:examples   # examples are compiled against src/, not decorative
npm test
npm run build
```

Everything in `examples/` is type-checked in CI. An example that no longer compiles is a
bug, not a stale sample.

## Changing the contract

A change to the API surface starts in `spec/openapi.yaml`:

1. Edit the spec.
2. `npm run lint:spec`
3. `npm run generate` and commit `src/generated/`.
4. Add or adjust the resource method, and a test that pins the behaviour.
5. Note it in `CHANGELOG.md` if a consumer would notice.

If you found the deployed API doing something the spec does not describe, open a
[contract drift](https://github.com/tiger-com/solana-unified-api/issues/new?template=contract_drift.yml)
issue rather than guessing at a schema. A wrong description is worse than a missing one.

## What the tests are for

The suite is not chasing coverage; it pins the behaviour that would otherwise cost someone
money:

- an intent is never resent under a new `request_id`
- a stored command surfaces as `PerpCommandError` instead of being retried
- decimals never round-trip through a float
- a stale snapshot never reaches a command fingerprint
- the core bundle imports neither `node:fs` nor the optional peers

If you change any of that, change the test that says so, and explain why in the PR.

## Style

- The core entry must stay isomorphic. Node-only code belongs in `src/node.ts`.
- `@solana/web3.js` and `centrifuge` stay out of the core bundle. CI checks this.
- Comments explain *why*. What the code does should be legible without them.
- Public API additions need a JSDoc block that a consumer can act on.

## Commits and releases

Write commit subjects in the imperative mood. Update `CHANGELOG.md` for anything an SDK
consumer would notice.

Releases are tag-driven: push `sdk-vX.Y.Z` matching `package.json`, and the release
workflow publishes to npm with provenance.

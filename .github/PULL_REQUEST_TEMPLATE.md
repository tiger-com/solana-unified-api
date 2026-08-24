## What changed

<!-- One or two sentences. Link the issue if there is one. -->

## Checklist

- [ ] `spec/openapi.yaml` is the source of truth — if a type changed, the spec changed
- [ ] `npm run generate` was run and `src/generated` is committed
- [ ] `npm test` and `npm run typecheck` pass
- [ ] `npm run typecheck:examples` passes — examples are compiled, not decorative
- [ ] `npm run lint:spec` passes
- [ ] `CHANGELOG.md` updated if this affects SDK consumers

## Anything reviewers should know

<!-- Trade-offs, things you deliberately left out, follow-ups. -->

# Contributing to Heliobond backend

This is the Heliobond backend — a Stellar indexer, REST API, and the oracle that scores projects on credit quality and green impact. TypeScript on Express, run with bun. Thanks for helping out.

## Pick something to work on

Browse [open issues](https://github.com/heliobond/backend/issues). Issues tagged **good first issue** are scoped for newcomers; **help wanted** are ready for anyone. Each issue has scope, acceptance criteria, and file pointers. Comment to claim it before you start.

## Setup

```bash
bun install
bun run dev      # start the API with the hourly cron
bun run test     # jest suite
bun run build    # tsc
```

## Workflow

1. Fork and branch from `main` (`feat/…`, `fix/…`, `test/…`).
2. Make your change. Keep it scoped to one issue.
3. Run the quality gate locally before pushing:
   ```bash
   bun run build    # must type-check
   bun run test     # all tests must pass
   ```
4. Open a PR with `Closes #<issue>`. CI runs `bun install`, `bun run build`, and `bun run test` — all must be green.

## Quality bar

- **Type-safe** — `bun run build` (tsc) must pass; no `any` escape hatches without a reason.
- **Tested** — new routes and logic need tests. We use jest + supertest; see `src/__tests__/`.
- **Validated input** — validate request bodies and params at the boundary; return structured JSON errors, never raw stack traces.
- **No secrets in code** — keys and RPC URLs come from the environment (`.env`), never committed.

## Reporting issues

Bugs and ideas: [open an issue](https://github.com/heliobond/backend/issues/new). Security problems: see [SECURITY.md](./SECURITY.md) — report privately, not in a public issue.

By contributing you agree your work is licensed under [Apache-2.0](./LICENSE), and you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).

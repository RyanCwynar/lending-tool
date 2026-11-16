# CLAUDE.md

Context for AI assistants working in this repo. It is committed on purpose: the assessment asks for the AI context used to build the project.

## What this is
Ryan Cwynar's take-home for Morpho's backend engineering assessment (brief: `docs/BRIEF.md`).
The product is a **Vault V2 timelock watcher**: it indexes `Submit` / `Accept` / `Revoke` on a few Base (chain 8453) Vault V2 vaults straight from the chain and delivers signed webhook alerts to subscribed systems.

- Design and rationale: `docs/PLAN.md`
- Ordered tasks with done-criteria: `docs/TASKS.md` (update the Status column as tasks finish)
- Evidence (API/app coverage, RPC findings, real onchain history, expected counts): `docs/research/timelock-history.md`

## Hard rules
- **Never use the Morpho API (`api.morpho.org`) in the service.** All chain data comes over RPC. The API may be read for research only.
- TypeScript, Postgres, GraphQL (graphql-yoga), docker-compose. No frontend, no new contracts, no Terraform/K8s/CI.
- **Scope is fixed in `docs/PLAN.md`.** New ideas go to its "Next steps" section, not into the build.
- Ryan must be able to explain every line. Prefer plain, boring code over clever code; comment the *why* for anything non-obvious.
- Never commit secrets. The RPC key comes from the environment (`ALCHEMY_API_KEY` in the VM's `~/.profile` → `RPC_URL`). `service/.env` is gitignored.

## Architecture invariants (don't break these)
- Three roles from one codebase: `indexer` (exactly one, Postgres advisory lock), `worker` (N), `api` (N). They share nothing but Postgres.
- The **indexer is the only writer of chain-derived data**. In **one transaction per block range** it writes events, change status, outbox (`delivery`) rows and the `sync_cursor`.
- The API writes only `subscription`; the worker writes only delivery status/attempts.
- Changes are keyed by `(vault, calldata)`, mirroring `executableAt[data]` in `VaultV2.sol`. Process logs in `(block, logIndex)` order.
- **Chain time, not wall clock**, for chain logic (executable/stale): use block timestamps. Wall clock only for polling, HTTP timeouts and retry backoff, injected as `now()` so tests can fake it.
- Amounts and caps are bigints end to end (`numeric` in Postgres, `BigInt` scalar in GraphQL). Never JS `number`.
- Webhook signing secrets are stored **encrypted (AES-256-GCM)**, never hashed, because we must sign with them.
- The service must not know whether `RPC_URL` is a real node or `mock-rpc`. No "replay mode" branches in service code.

## Layout
- `service/`: the app (`src/config.ts`, `src/db/`, `src/rpc/`, `src/graphql/`, `migrations/`)
- `reference/`: upstream clones of `morpho-blue` and `vault-v2` (gitignored). Read the contracts here before assuming behaviour.
- `docs/`: brief, plan, tasks, research

## Commands (from `service/`)
- `pnpm dev`: run with `.env`
- `pnpm migrate`: apply SQL migrations
- `pnpm test` (Vitest) · `pnpm typecheck` · `pnpm build`
- `docker compose up` from the repo root boots Postgres and the app

## Environment notes
- Network goes through a proxy; blocked hosts show up in `devvm-why`. Free public Base RPCs don't serve historical `eth_getLogs` (see research §2); Alchemy does.

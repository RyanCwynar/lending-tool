# Tasks

Build order for the Vault V2 timelock watcher (design: `PLAN.md`; evidence: `research/timelock-history.md`).
Each task ends with something runnable. The fixture and mock-rpc come first, so every later task is developed against fixed, offline data.
The 5-hour figure in the brief is a guide to the size of work, not a hard limit; the cut list is at the bottom.

| # | Task | Done when | Status |
|---|---|---|---|
| 0 | Commit plan, task list, research doc, `CLAUDE.md` | AI context and sources are in the repo | done |
| 1 | **Fixture capture** (`scripts/capture-fixture`): material blocks (number, hash, parent hash, timestamp, raw logs) for the 4 demo vaults, plus recorded `eth_call` results the service needs (vault `name`/`asset`, token `symbol`/`decimals`) | `fixtures/base-timelocks.json` committed; regenerated with one command given `RPC_URL` | done (648 logs, 172 headers, 58 recorded calls) |
| 2 | **mock-rpc**: `eth_chainId`, `eth_blockNumber`, `eth_getLogs`, `eth_getBlockByNumber`, `eth_call` (from the recorded table); virtual head; `reset` / `play` / `pause` / `advance-to` | viem pointed at mock-rpc returns the same logs as Alchemy for the same range | done (9 tests; 333 Submits served via viem) |
| 3 | **Schema**: migrations for `vault`, `vault_event`, `timelock_change`, `subscription`, `delivery` | `pnpm migrate` runs clean on a fresh DB | done |
| 4 | **Decoding**: calldata → function + args; `idData` → collateral / market / adapter label; selector → name; `unlimited` caps; unknown selectors kept raw | Unit tests pass on real calldata samples from the fixture | done (10 tests on real calldata) |
| 5 | **Lifecycle reducer** (pure: ordered events → changes) | Tests: zero timelock, resubmission after accept/revoke, orphan accept | done (7 tests) |
| 6 | **Indexer loop**: cursor, confirmations, adaptive range, one DB transaction per range, reorg hash check, advisory lock | Full replay gives exactly the research numbers (333 changes; per-vault executed/revoked/pending as in research §3; 0 orphans); a second run adds nothing | done (exact research counts; idempotent re-run; range halving; reorg rewind; lock) |
| 7 | **API, read side**: `health` (+ indexer lag), `vaults`, `timelockChanges` (+ `stale`), `deliveries` | "What was pending on 2026-11-11?" answerable during a paused replay | done (also `pendingAt:` for any past moment; e2e test) |
| 8 | **Subscriptions**: create/deactivate, secret generated + returned once + stored AES-GCM encrypted, SSRF check, `start_block` | Secret not recoverable from the DB without the key; private URLs rejected unless `WEBHOOK_ALLOW_PRIVATE` | done (security tests: wrong key/tamper/row-swap fail; SSRF re-checked at connect time) |
| 9 | **Outbox matching** inside the indexer transaction | Deliveries only for matching filters and only after `start_block` | done (e2e: 648 per all-vault subscriber, filters exact, no duplicates on re-index) |
| 10 | **Delivery worker**: claim with `SKIP LOCKED`, HMAC sign, POST, backoff, max attempts | Retry schedule tested with an injected clock; signature round-trip test | done (e2e: flaky delivered on attempt 3, down FAILED after 8, slow times out without blocking) |
| 11 | **Mock receivers** `/ok` `/flaky` `/down` `/slow`, `POST /control/register` (path + secret), `GET /received` | Receivers verify signatures and count duplicate delivery ids | done |
| 12 | **Replay script** with assertions | One command: reset → subscribe (register secrets) → play → timeline + pass/fail | todo |
| 13 | **Roles + docker-compose**: `indexer`, `worker`, `api`, `mock-rpc`, `mock-receivers`, `postgres` | `docker compose up` + replay works with no RPC key | todo |
| 14 | **README** (architecture + run) and **BusinessCase.md** (1 page) | Brief deliverables complete | todo |

Cut list, if needed, in this order: mock-rpc fault injection → `/slow` receiver → `stale` filter → role split (fall back to `ROLE=all`).
Stretch, after 14: `change.executable` alert; reorg scenario in the fixture.

# Vault V2 Timelock Watcher

**Push alerts for curator policy changes on Morpho Vault V2, read straight from the chain.**

```
2026-11-09 07:44  SUBMITTED  Steakhouse High Yield USDC Edition   Increase absolute cap on collateral cbBTC to 500,000,000 USDC (executable 2026-11-12 07:44)
2026-11-12 15:02  EXECUTED   Steakhouse High Yield USDC Edition   Increase absolute cap on collateral cbBTC to 500,000,000 USDC
```

## Why this exists
Vault V2 protects depositors with timelocks. A curator who wants to raise risk (raise a cap, add an adapter, change fees, shorten a timelock) must `submit` the change and wait days before anyone can execute it, so depositors get time to leave. **That protection only works if someone notices in time.**

Today, noticing means polling the Morpho API, opening the Curator App, or reading raw events. The data is visible, but nothing *tells* you. The parties who most need to know are systems, not people: integrators, fintechs, treasuries and custodians routing deposits into vaults. Their risk engines need a machine signal ("this vault's cbBTC exposure can rise to $500M on Thursday") so they can pause deposits, alert a risk desk or rebalance.

This service watches Vault V2 vaults on Base, decodes every timelocked change into plain language, and **POSTs a signed webhook** to subscribers when a change is **submitted**, **executed** or **revoked**. It is not hypothetical: the 12 largest Base V2 vaults made 808 timelocked changes between October 2025 and November 2026, including a 100M USDC syrupUSDC cap that sat pending for 5 weeks before the curator revoked it, and vaults with a zero timelock, where no notice is possible at all ([research](docs/research/timelock-history.md)).

Why this build and not another, its value to Morpho, and what comes next: [BusinessCase.md](BusinessCase.md).

## What a subscriber receives
```
POST https://your-system.example/morpho-alerts
x-delivery-id: 7550f869-6c51-4f8c-b4ec-16aad8b7ee8b     same on every retry: dedupe on it
x-signature:   t=1794850000,v1=5f0c…                    HMAC-SHA256(secret, "<t>.<raw body>")
```
```jsonc
// trimmed; full bodies in examples/webhooks/
{
  "type": "change.submitted",                       // or change.executed / change.revoked
  "vault":  { "name": "Steakhouse High Yield USDC Edition", "address": "0xbeef…8845" },
  "change": {
    "summary": "Increase absolute cap on collateral cbBTC to 500,000,000 USDC",
    "functionName": "increaseAbsoluteCap",
    "args": { "idData": "0x…", "newAbsoluteCap": "500000000000000" },     // exact uint256 as a string
    "decoded": { "capId": { "kind": "collateral", "token": "0xcbB7…33Bf" }, "newCapFormatted": "500,000,000 USDC" },
    "status": "PENDING", "submittedAt": "2026-11-09T07:44:11.000Z", "executableAt": "2026-11-12T07:44:11.000Z"
  },
  "event": { "name": "Submit", "txHash": "0x1109…b9", "blockNumber": 55099378, "blockTimestamp": "2026-11-09T07:44:11.000Z" },
  "chainId": 8453,
  "deliveryId": "7550f869-6c51-4f8c-b4ec-16aad8b7ee8b"
}
```
Subscribe through the API (`createSubscription`, optionally filtered by vault and function) and keep the secret it returns once. To accept a webhook: verify the signature in constant time, reject a `t` older than 5 minutes, dedupe on `x-delivery-id`, and answer 2xx within 5 s. Anything else is retried after 30s, 2m, 10m, 1h, 3h, 6h and 12h; after 8 failed attempts the delivery is marked `FAILED` and shows as failed in the API. Full real examples and a verification function: [examples/webhooks/](examples/webhooks/).

## Quick start (offline, no RPC key)
Requires Docker. This replays 13 months of **real recorded Base history** through the unmodified service:
```bash
docker compose up -d                       # postgres, indexer, worker, api, mock-rpc, mock-receivers
docker compose run --rm --build replay     # ~2-3 min; prints the timeline, then checks the results
```
The replay subscribes four test endpoints that each misbehave in a different way, then checks that the service handled every one correctly:
```
/ok     delivered  648  failed    0  pending   0   |  requests   648 …   always accepts: every alert exactly once
/flaky  delivered  648  failed    0  pending   0   |  requests  1944 …   fails twice per alert, then accepts: 3 tries each
/down   delivered    0  failed  648  pending   0   |  requests  5184 …   always fails: 8 tries each, then FAILED
/slow   delivered    0  failed    0  pending   58  |  requests   132 …   answers after the 5 s timeout, without slowing the others
PASS  changes by status match research §3 ({"PENDING":18,"EXECUTED":307,"REVOKED":8})
…
all checks passed
```
The demo shrinks the retry schedule 1000× (`RETRY_SCHEDULE_SCALE=0.001`), so `/down` gives up in about 80 s instead of about 22 h. If ports 4000/5432/8545/9000 are taken: `API_PORT=4100 PG_PORT=55433 MOCK_RPC_PORT=18546 MOCK_RECEIVERS_PORT=19000 docker compose up -d` (`./demo` finds the ports itself).

## Try it yourself
`./demo` drives the recorded chain's clock. Follow the cbBTC change from the top of this page as it happens:
```bash
./demo reset                               # back to the start, old subscriptions off, receivers cleared
./demo goto 2026-11-08                     # the day before the submission (the indexer catches up first)
./demo subscribe /ok increaseAbsoluteCap   # a subscriber that only cares about absolute-cap increases
./demo watch                               # in a second terminal: webhooks as they arrive
./demo play 6h/1s                          # run time forward at 6 hours per second; ./demo pause to stop
```
```
2026-11-09 07:44  /ok?sub=504430     200  change.submitted  Steakhouse High Yield USDC Edition: Increase absolute cap on collateral cbBTC to 500,000,000 USDC
2026-11-10 23:19  /ok?sub=504430     200  change.submitted  Gauntlet USDC Frontier: Increase absolute cap on collateral PAXG to 2,000,000 USDC
2026-11-12 15:02  /ok?sub=504430     200  change.executed   Steakhouse High Yield USDC Edition: Increase absolute cap on collateral cbBTC to 500,000,000 USDC
```
Each line shows when the event happened onchain, which subscription received it, the response, and the retry attempt if any. Try `./demo subscribe /flaky` to watch retries, or `/down` to watch one give up.

| Command | What it does |
|---|---|
| `./demo goto <date \| start \| end>` | Go to a date (UTC; a bare date means midnight). **Back** rewinds: everything after it is forgotten. **Forward** replays the events in between. |
| `./demo play [speed]` / `pause` | Run time forward (`1d/1s` default, `6h/1s`, `1w/1s`, …) / stop |
| `./demo subscribe [endpoint] [function…]` | Subscribe `/ok` (default), `/flaky`, `/down` or `/slow`, optionally to some functions only. It receives events after the current point. |
| `./demo watch` / `status` | Live webhook feed / chain time, indexed-up-to time, deliveries per subscription |
| `./demo reset` | Clean slate |

Then look at it from the service's side in **GraphiQL** at <http://localhost:4000/graphql>. It opens on a 12-step walkthrough, one tab per step: `Step1_IsItHealthy`, `Step2_WhatCanExecuteNow`, `Step3_TheCbBTCStory`, `Step4_CuratorBackedDown` (the syrupUSDC revoke), `Step5_PendingOnADate`, `Step7_DeliveryTrail`, `Step8_FailedDeliveries`, through to subscribing. The tabs are in [playground.ts](service/src/graphql/playground.ts), and a test validates every query against the schema.

**Rewind in production.** `goto` back in time uses a rewind that works against any node: `docker compose exec indexer node dist/indexer/rewind-cli.js 2026-06-01` forgets every event, change and alert after that time (changes resolved later go back to PENDING; subscriptions are kept), and the indexer re-processes forward from there and re-sends those alerts with new delivery ids. It is safe while the service runs, and useful after fixing a decoding bug.

### Live mode (real Base)
Needs a provider that serves historical `eth_getLogs`. Public endpoints don't ([research §2](docs/research/timelock-history.md)); a free Alchemy key does.
```bash
RPC_URL=https://base-mainnet.g.alchemy.com/v2/<key> LOG_RANGE=100000 RETRY_SCHEDULE_SCALE=1 \
WEBHOOK_ALLOW_PRIVATE=false SECRET_ENCRYPTION_KEY=$(openssl rand -base64 32) \
docker compose up -d postgres indexer worker api
```
Watched vaults are configured with `VAULTS=address:creationBlock,…` (defaults to the four demo vaults).

## Architecture
```
                 RPC_URL ── Base node (Alchemy)  or  mock-rpc (recorded history, controllable clock)
                    │ eth_getLogs: Submit / Accept / Revoke from the watched vaults (one call covers all of them)
                    ▼
 ┌─────────────── indexer (exactly one: Postgres advisory lock) ───────────────┐
 │ poll head → stay CONFIRMATIONS behind → check cursor hash (reorg?) → fetch logs │
 │ decode calldata → lifecycle (PENDING → EXECUTED | REVOKED) → match subscriptions │
 │ ONE TRANSACTION per block range: events + change status + outbox + cursor      │
 └──────────────────────────────────────┬──────────────────────────────────────────┘
                                        ▼
                                    Postgres ◄──────── api (any number): GraphQL visibility + subscriptions
                                        │
 ┌──────────── worker (any number) ─────┴──────────┐
 │ claim due deliveries (FOR UPDATE SKIP LOCKED + lease) │ ──POST, signed──► subscriber webhooks
 │ send outside any transaction · retry 30s … 12h × 8     │
 └──────────────────────────────────────────────────────┘
```
One codebase and one Docker image; `ROLE=indexer|worker|api|all` picks what a process runs. The roles share nothing but Postgres, so each scales by its own rule: the indexer is a singleton (a second one is refused and waits as a standby), and workers and API instances scale horizontally.

**Data flow.** Vault V2 keeps pending actions as `executableAt[calldata]`, so a change is identified by `(vault, calldata)`. `Submit` creates it, and `Accept` or `Revoke` resolves it ([lifecycle.ts](service/src/indexer/lifecycle.ts), a pure function). The indexer is the **only writer of chain-derived data**; the API writes only subscriptions; the worker writes only delivery results.

**Correctness properties, and where they live**
| Property | How | Code |
|---|---|---|
| No lost or duplicated alerts across crashes | Outbox pattern: deliveries are inserted in the same transaction as the event and the cursor; unique keys make re-processing a no-op | [indexer.ts](service/src/indexer/indexer.ts), [outbox.ts](service/src/delivery/outbox.ts) |
| Reorg safety | Index only `CONFIRMATIONS` behind the head; if the stored cursor hash is no longer canonical, undo above a fork point and re-index | `Indexer.rewind`, [rewind.ts](service/src/indexer/rewind.ts) |
| Safe rewind while running | Reorg and manual rewind share one undo routine; the indexer only advances the cursor from where its tick started, so an overlapping tick rolls back instead of skipping the rewound range | [rewind.ts](service/src/indexer/rewind.ts) |
| At-least-once delivery | Retries with backoff; `X-Delivery-Id` is stable so receivers dedupe | [worker.ts](service/src/delivery/worker.ts) |
| One bad endpoint can't hurt others | Continuous send pool, per-subscription in-flight cap, 5s timeout, no redirects | `DeliveryWorker.run`, `claim` |
| Authentic alerts | HMAC-SHA256 over `t.body` with a per-subscription secret; secrets **encrypted** at rest (AES-256-GCM bound to the subscription id), not hashed, because we must sign with them | [signing.ts](service/src/delivery/signing.ts), [secrets.ts](service/src/delivery/secrets.ts) |
| No SSRF through webhook URLs | Private/loopback/link-local refused at subscription time **and** inside the connection's DNS lookup (defeats DNS rebinding) | [url-guard.ts](service/src/delivery/url-guard.ts) |
| Odd onchain data never stops indexing | Calldata decoding never throws; unknown or non-timelocked submissions are stored raw and flagged (real vaults have `setName` submissions pending for a year) | [decode.ts](service/src/chain/decode.ts) |
| Exact integers | uint256 values stay bigint / `numeric` / strings end to end | `BigInt` scalar |

### Decisions
- **Push, not another dashboard.** The Morpho API and app already show pending changes. What's missing is delivery: no subscriptions, and no Submit/Accept/Revoke history ([research §1](docs/research/timelock-history.md)). So the product is the webhook, and the API is for visibility and auditing deliveries.
- **Read the chain ourselves.** An independent source doesn't depend on Morpho's indexer (and the brief rules out the Morpho API). One `getLogs` call covers every watched vault, so cost grows with blocks, not vaults.
- **A narrow scope, built carefully.** Base only, four allowlisted vaults, timelock events only. The effort went into data integrity and failure paths rather than breadth. State-based alerts (relative-cap breaches, allocation drift) reuse this pipeline and are next ([BusinessCase.md](BusinessCase.md)).
- **An outbox, not sending from the indexer.** An alert exists if and only if its event was committed, and a slow subscriber can never stall indexing.
- **Chain time, not wall-clock time.** "Executable?" and "stale?" use the last indexed block's timestamp, as the contract uses `block.timestamp`. That's also why the demo needs no special mode: mock-rpc fakes time by moving the chain head, and the service code is identical in demo and production.
- **Postgres.** We need transactions across events, status, outbox and cursor; unique constraints for idempotency; and a safe work queue (`SKIP LOCKED`). One dependency covers all three at this volume (a few curator actions per vault per week).
- **Recorded real history as the test bed.** The replay and the integration tests run the real indexer over 648 recorded Base events and check the counts against numbers computed independently in the research doc, rather than against synthetic fixtures.

## Development
```bash
cd service && pnpm install
pnpm test                                    # unit tests (decoder, lifecycle, signing, SSRF, mock-rpc, GraphiQL tabs)
TEST_DATABASE_URL=postgres://morpho:morpho@localhost:5432/morpho pnpm test   # + integration tests on real Postgres
pnpm typecheck
RPC_URL=<alchemy url> pnpm capture-fixture   # re-record fixtures/base-timelocks.json from Base
```
The integration tests create and drop their own databases. They replay the fixture through the real indexer, check rewind and reorg recovery, then run the full path (API → indexer → outbox → worker → receivers) on an injected clock.

| Path | What |
|---|---|
| `service/src/indexer/` | chain reader, lifecycle reducer, indexer loop, singleton lock, rewind |
| `service/src/delivery/` | outbox, worker, subscriptions, signing, secrets, SSRF guard |
| `service/src/chain/` | Vault V2 ABI, calldata/idData decoding, readable summaries |
| `service/src/graphql/` | schema, resolvers, GraphiQL walkthrough |
| `service/src/harness/` | fixture capture, mock-rpc, mock-receivers, replay (demo/test only) |
| `service/migrations/` | SQL schema |
| `demo` | command-line driver for the offline demo |
| `docs/`, `CLAUDE.md` | brief, plan, task log, research, and the AI context used to build this |

## Known limitations
- Watched vaults come from config, not factory discovery. A vault added later than the cursor isn't backfilled automatically.
- Only the Morpho Market V1 adapter's cap ids are decoded into labels; other adapters show raw ids.
- A webhook already delivered for an event that is later reorged out can't be recalled (that's why we wait for confirmations).
- No subscriber authentication: anyone who can reach the API can create subscriptions. Production would add API keys (stored hashed: verify-only secrets *should* be hashed).
- mock-rpc interpolates timestamps of blocks it didn't record (Base's block time changed over the period); recorded blocks are exact.

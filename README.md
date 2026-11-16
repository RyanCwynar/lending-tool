# Vault V2 Timelock Watcher

**Push alerts for curator policy changes on Morpho Vault V2, read straight from the chain.**

Vault V2 protects depositors with timelocks: a curator who wants to raise risk (raise a cap, add an adapter, change fees, shorten a timelock) must `submit` the change and wait before anyone can execute it. That protects depositors only if someone notices in time. This service watches Base vaults onchain, decodes every timelocked change into plain language ("Increase absolute cap on collateral cbBTC to 500,000,000 USDC, executable 2026-11-12 07:44"), and delivers signed webhooks to subscribed systems (integrators, institutional depositors, curators) when a change is **submitted**, **executed** or **revoked**.

- Why this and not something else: [BusinessCase.md](BusinessCase.md)
- Design and decisions: [docs/PLAN.md](docs/PLAN.md) · build log: [docs/TASKS.md](docs/TASKS.md) · evidence: [docs/research/timelock-history.md](docs/research/timelock-history.md)
- Real example alerts: [examples/webhooks/](examples/webhooks/)

## Run it (offline demo, no RPC key needed)
Requires Docker.
```bash
docker compose up -d                       # postgres, indexer, worker, api, mock-rpc, mock-receivers
docker compose run --rm --build replay     # replays 13 months of real Base history through the service (~2-3 min)
```
The replay resets everything, subscribes four webhook endpoints through the API, plays the recorded chain at 2 weeks per second while printing curator changes as the service sees them, waits for deliveries to settle, then checks the results:
```
2026-11-09 07:44  SUBMITTED  Steakhouse High Yield USDC Edition   Increase absolute cap on collateral cbBTC to 500,000,000 USDC (executable 2026-11-12 07:44)
2026-11-12 15:02  EXECUTED   Steakhouse High Yield USDC Edition   Increase absolute cap on collateral cbBTC to 500,000,000 USDC
…
/ok     delivered  648  failed    0  pending   0   |  requests   648  accepted  648  bad signatures 0
/flaky  delivered  648  failed    0  pending   0   |  requests  1944  accepted  648  bad signatures 0
/down   delivered    0  failed  648  pending   0   |  requests  5184  accepted    0  bad signatures 0
/slow   delivered    0  failed    0  pending  58   |  requests   132  accepted   58  bad signatures 0
PASS  changes by status match research §3 ({"PENDING":18,"EXECUTED":307,"REVOKED":8})
PASS  /ok received every alert exactly once (648/648)
PASS  /flaky delivered everything after retries (1944 requests)
PASS  /down gave up after max attempts (648 failed)
PASS  /slow timed out (not delivered) without blocking others (0 failed, 58 pending)
PASS  no request had an invalid signature
```
Then explore in GraphiQL at <http://localhost:4000/graphql>:
```graphql
{
  health { ok indexer { lastBlock lagBlocks chainTime } }
  # what can happen right now? (pending, past its timelock, and not years-old junk)
  timelockChanges(status: PENDING, stale: false) { vault { name } summary executableAt executable }
  # what was pending at a past moment?
  pending: timelockChanges(pendingAt: "2026-09-15T00:00:00Z") { vault { name } summary status }
}
```
```graphql
mutation {
  createSubscription(input: { url: "http://mock-receivers:9000/ok", functions: ["increaseAbsoluteCap", "addAdapter"] }) {
    secret            # shown once; verifies X-Signature
    subscription { id startBlock }
  }
}
```
Replay knobs: `SPEED=1w/1s`, `TIMELINE=all|notable|none`. The mock chain can also be driven by hand: `curl -XPOST 'localhost:8545/control/advance-to?time=2026-11-12T15:00:00Z'`, `/control/play?speed=1d/2s`, `/control/pause`, `/control/faults?rate429=0.2&rangeLimit=5000`.
If ports 4000/5432/8545/9000 are taken: `API_PORT=4100 PG_PORT=55433 MOCK_RPC_PORT=18546 MOCK_RECEIVERS_PORT=19000 docker compose up -d`.

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
| Reorg safety | Index only `CONFIRMATIONS` behind the head; if the stored cursor hash is no longer canonical, undo above a fork point and re-index | `Indexer.rewind` |
| At-least-once delivery | Retries with backoff; `X-Delivery-Id` is stable so receivers dedupe | [worker.ts](service/src/delivery/worker.ts) |
| One bad endpoint can't hurt others | Continuous send pool, per-subscription in-flight cap, 5s timeout, no redirects | `DeliveryWorker.run`, `claim` |
| Authentic alerts | HMAC-SHA256 over `t.body` with a per-subscription secret; secrets **encrypted** at rest (AES-256-GCM bound to the subscription id), not hashed, because we must sign with them | [signing.ts](service/src/delivery/signing.ts), [secrets.ts](service/src/delivery/secrets.ts) |
| No SSRF through webhook URLs | Private/loopback/link-local refused at subscription time **and** inside the connection's DNS lookup (defeats DNS rebinding) | [url-guard.ts](service/src/delivery/url-guard.ts) |
| Odd onchain data never stops indexing | Calldata decoding never throws; unknown or non-timelocked submissions are stored raw and flagged (real vaults have `setName` submissions pending for a year) | [decode.ts](service/src/chain/decode.ts) |
| Exact integers | uint256 values stay bigint / `numeric` / strings end to end | `BigInt` scalar |

**Time.** "Is it executable?" and "is it stale?" use **chain time** (the last indexed block's timestamp), as the contract does with `block.timestamp`. That's also why replay needs no special mode: mock-rpc fakes time by moving the chain head, and the service code is identical in demo and production. Wall-clock time is used only for polling, HTTP timeouts and retries.

**Why Postgres.** We need transactions across events, status, outbox and cursor; unique constraints for idempotency; and a safe work queue (`SKIP LOCKED`). One dependency covers all three at this volume (a few curator actions per vault per week).

**Scaling notes.** Chain-side cost depends on blocks, not vaults: one `getLogs` call covers every vault, and the log range adapts when a provider rejects it. Delivery throughput grows by adding workers. Going multi-chain means one cursor stream per chain.

## Development
```bash
cd service && pnpm install
pnpm test                                    # unit tests (decoder, lifecycle, signing, SSRF, mock-rpc)
TEST_DATABASE_URL=postgres://morpho:morpho@localhost:5432/morpho pnpm test   # + integration tests on real Postgres
pnpm typecheck
RPC_URL=<alchemy url> pnpm capture-fixture   # re-record fixtures/base-timelocks.json from Base
```
The integration tests create and drop their own databases. They replay the fixture through the real indexer and check the counts against the independently computed numbers in the research doc, then run the full path (API → indexer → outbox → worker → receivers) on an injected clock.

| Path | What |
|---|---|
| `service/src/indexer/` | chain reader, lifecycle reducer, indexer loop, singleton lock |
| `service/src/delivery/` | outbox, worker, subscriptions, signing, secrets, SSRF guard |
| `service/src/chain/` | Vault V2 ABI, calldata/idData decoding, readable summaries |
| `service/src/graphql/` | schema and resolvers |
| `service/src/harness/` | fixture capture, mock-rpc, mock-receivers, replay (demo/test only) |
| `service/migrations/` | SQL schema |
| `docs/`, `CLAUDE.md` | brief, plan, task log, research, and the AI context used to build this |

## Known limitations
- Watched vaults come from config, not factory discovery. A vault added later than the cursor isn't backfilled automatically.
- Only the Morpho Market V1 adapter's cap ids are decoded into labels; other adapters show raw ids.
- A webhook already delivered for an event that is later reorged out can't be recalled (that's why we wait for confirmations).
- No subscriber authentication: anyone who can reach the API can create subscriptions. Production would add API keys (stored hashed: verify-only secrets *should* be hashed).
- mock-rpc interpolates timestamps of blocks it didn't record (Base's block time changed over the period); recorded blocks are exact.

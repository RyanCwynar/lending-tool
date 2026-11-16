# Plan: Vault V2 Timelock Watcher

Decided 2026-11-16. Scope is fixed; anything not listed under **In scope** goes to BusinessCase.md as future work.

## One sentence
Actively alert subscribed systems to **curator policy changes** on Morpho Vault V2. Concretely: watch a small set of Base vaults for changes entering the timelock, record each one with the time it becomes executable, and push a webhook to subscribers when a change is **submitted**, **executed**, or **revoked**.

## Why
- Vault V2's non-custodial guarantee works like this: changes that raise risk (cap increases, new adapters, fee changes, timelock reductions…) must be **submitted** and wait out a timelock before anyone can **accept** them. Depositors get time to exit. That only protects them if someone notices the submission in time.
- The Morpho API already exposes the pending queue (`VaultV2.pendingConfigs`), and the Curator App shows it to operators. But the API is pull-only, with no subscriptions, and the depositor app shows timelock *lengths*, not a clear pending list.
- Hypernative (commercial) and `yearn/monitoring` (open source) do alerting. Our version is a small, open, **onchain-sourced** building block an integrator can run themselves, with an explicit delivery guarantee.
- **Audience is systems, not people:** apps routing deposits into vaults, institutional depositors, curators and sentinels. People are reached indirectly, through a webhook pointed at Slack, Discord or Telegram, or through the integrator's app.

## In scope
1. **Indexer** for `Submit`, `Accept` and `Revoke` on an allowlist of 3–5 Base vaults, backfilled from each vault's creation block.
2. **Decoding** of the timelocked calldata into function name and arguments (all timelocked functions via the vault ABI). For cap increases, also decode `idData` into a readable risk id: adapter / collateral token / market.
3. **Lifecycle** for each change: `PENDING → EXECUTED | REVOKED`.
4. **Subscriptions:** webhook URL with optional filters (vaults, function names).
5. **Delivery:** outbox table plus a worker with retries and backoff, at-least-once, with an idempotency key.
6. **GraphQL** queries and mutations for all of the above.
7. **Stretch, only if over 45 minutes remain:** a `becomesExecutableWithin` filter, and/or a `change.executable` alert fired when `executableAt` passes.

## Out of scope (future work; see "Next steps" below)
Relative-cap breach and booked-vs-live drift alerts · discovering all vaults through the factory · cap decreases (immediate, not timelocked, and they reduce risk) · signed payloads, auth and multi-tenancy · email/SMS · other chains · Blue position health · vault ranking · automated exit/rebalancing (subscribers act with their own keys; we never touch funds).

## How it works
```
           Base RPC (Alchemy)
                 │  eth_getLogs(address=[allowlist], topic0 ∈ {Submit, Accept, Revoke})
                 ▼
   ┌──────────── Indexer loop ─────────────┐   only up to head − CONFIRMATIONS
   │ decode → apply lifecycle → match subs │
   │ ONE DB TRANSACTION per block range:   │
   │   insert vault_event (dedupe)         │
   │   upsert timelock_change              │
   │   insert delivery rows (outbox)       │
   │   advance sync_cursor (+ block hash)  │
   └───────────────────────────────────────┘
                 │ Postgres
                 ▼
   Delivery worker ── POST JSON ──▶ subscriber webhook
     claim due rows (SKIP LOCKED), 2xx → delivered, else retry with backoff, give up after N
                 ▲
   GraphQL API (yoga): visibility (changes, deliveries, health/lag) + manage subscriptions
```
## Three roles, one codebase, one image
`node dist/main.js indexer | worker | api` (plus `ROLE=all` for local dev). docker-compose runs the same image three times, plus Postgres.

| Role | Job | Writes | Copies |
|---|---|---|---|
| **Indexer** | Poll chain, filter `Submit`/`Accept`/`Revoke`, decode, update change status, queue a delivery for each matching subscription | `vault_event`, `timelock_change`, `delivery` (new rows), `sync_cursor` (the **only** writer of chain-derived data) | **Exactly one**, enforced with a Postgres advisory lock (`pg_try_advisory_lock`); a second instance exits |
| **Delivery worker** | Claim due deliveries (`FOR UPDATE SKIP LOCKED`), POST them, record result, schedule retries | `delivery` status/attempts only | Any number |
| **API** | Visibility into what the indexer and worker are doing, plus subscription management | `subscription` only | Any number |

Why split:
- **Different scaling rules:** the indexer is a singleton; workers and the API scale horizontally.
- **Fault isolation:** the worker talks to untrusted external servers, so slow, broken or hostile endpoints can't stall indexing or the API.
- **Security:** the worker is the only component that requests user-supplied URLs, which is the SSRF surface. We reject private and loopback URLs at subscription time; network-isolating the worker is listed as hardening.

The roles share nothing but Postgres. Matching subscriptions happens in the **indexer**, in the same transaction as the event, so "it happened" and "these subscribers must hear about it" are saved together or not at all.

## Contract facts we rely on (from `reference/vault-v2/src`)
- `event Submit(bytes4 indexed selector, bytes data, uint256 executableAt)`
- `event Accept(bytes4 indexed selector, bytes data)`
- `event Revoke(address indexed sender, bytes4 indexed selector, bytes data)`
- The contract tracks pending actions as `executableAt[data]`, keyed by the **full calldata**. `submit` reverts with `DataAlreadyPending` if that calldata is already pending. So: **at most one pending change per (vault, data)**, and the same calldata *can* be submitted again after it's accepted or revoked.
- Timelocks can be **0**, so `Submit` and `Accept` can land in the same block or transaction. Events must be processed in `(block, logIndex)` order.
- Cap ids are `keccak256(idData)`. The Blue market adapter's ids are `abi.encode("this", adapter)`, `abi.encode("collateralToken", token)` and `abi.encode("this/marketParams", adapter, marketParams)`.

## Data model (Postgres)
- `sync_cursor` (exists): `stream`, `last_block`, `block_hash`.
- `vault`: `address` PK, `creation_block`, `name`, `asset`. Seeded from config.
- `vault_event`: raw decoded logs. Unique `(tx_hash, log_index)`, so replaying a range does nothing.
- `timelock_change`: `id`, `vault`, `data` (bytea), `selector`, `function_name`, `args` (jsonb), `status`, `submitted_block/tx/at`, `executable_at`, `resolved_block/tx/at`, `revoked_by`.
  Partial unique index on `(vault, data) WHERE status = 'PENDING'`, mirroring the contract rule.
- `subscription`: `id`, `url`, `vaults[]` (null = all), `functions[]` (null = all), `created_at`, `active`.
- `delivery` (outbox): `id` (also the idempotency key), `subscription_id`, `change_id`, `event_type`, `payload` jsonb, `status` (`PENDING | DELIVERED | FAILED`), `attempts`, `next_attempt_at`, `last_error`, `last_status_code`.
  Unique `(subscription_id, change_id, event_type)`, so a change can't be alerted twice to one subscriber.

## Correctness rules (the parts reviewers will probe)
- **Idempotent indexing:** event inserts, change upserts, outbox rows and the cursor update commit together. A crash anywhere replays the range with no duplicates.
- **Reorgs:** index only to `head − CONFIRMATIONS` (default 10 blocks, about 20s on Base). Before each range, check that the stored cursor hash is still canonical. If not, log loudly, roll the cursor back, delete rows above the fork point, and re-index. A webhook already sent for a reorged-out event can't be recalled. That's why we wait for confirmations, and it's a documented limitation.
- **No alerts for history:** a subscription only gets deliveries for events with `block_timestamp >= subscription.created_at`, so backfills and new vaults don't flood subscribers. (Optional `since` argument for demos.)
- **Accept/Revoke with no known Submit:** shouldn't happen because we backfill from creation. If it does, store the event, log a warning, and skip the lifecycle update. Never crash the loop.
- **Delivery:** at-least-once. Each POST carries `X-Delivery-Id`, so receivers can deduplicate. 5s timeout; any non-2xx response or a timeout is retried with exponential backoff (30s → 2m → 10m → 1h…), up to 8 attempts, then `FAILED`. A slow or broken endpoint affects only its own rows.
- **Bigints:** amounts and caps stay `numeric`/strings end to end (BigInt scalar), never JS numbers.

## API sketch
```graphql
type Query {
  health: Health!          # DB + RPC reachable, indexer lag (chain head − last processed block)
  vaults: [Vault!]!
  timelockChanges(vault: Address, status: ChangeStatus, executableBefore: Timestamp): [TimelockChange!]!
  subscriptions: [Subscription!]!
  deliveries(subscriptionId: ID!, status: DeliveryStatus): [Delivery!]!
}
type Mutation {
  createSubscription(url: String!, vaults: [Address!], functions: [String!], since: Timestamp): Subscription!
  deactivateSubscription(id: ID!): Subscription!
}
```
Webhook payload: `{ id, type: "change.submitted"|"change.executed"|"change.revoked", chainId, vault, change: { functionName, args, executableAt, txHash, blockNumber } }`.

## Config (env)
`RPC_URL`, `CHAIN_ID` (exist) · `VAULTS` (comma-separated allowlist) · `CONFIRMATIONS=10` · `POLL_INTERVAL_MS=4000` · `LOG_RANGE=10000` · `DELIVERY_MAX_ATTEMPTS=8`.

## Tests
- Unit: the lifecycle reducer (pure: events → changes), including zero timelock, resubmission after accept or revoke, and orphan accept; the `idData` decoder; the backoff schedule.
- Integration (real Postgres from docker-compose): index the same range twice and check no duplicate events, changes or deliveries; simulate a reorg (hash mismatch) and check the rollback.
- Demo: `scripts/webhook-receiver` prints incoming POSTs; subscribe with `since` to replay a real recent `Submit`.

## Time budget (~4h)
| Step | Time |
|---|---|
| Migrations + config + vault ABI/decoder | 30m |
| Indexer loop, lifecycle reducer, reorg check | 1h15 |
| Outbox + delivery worker | 45m |
| Role entry point, advisory lock, compose services | 20m |
| GraphQL | 30m |
| Tests + demo receiver | 30m |
| README architecture + BusinessCase.md | 30m |

## Open items
- **Which vaults:** once `RPC_URL` points at Alchemy, pick 3–5 large Base vaults with recent `Submit` activity (good for the demo).
- RPC key lives only in `service/.env` (gitignored).

## Next steps: more alert types for subscribed systems
The outbox doesn't care where an alert comes from, so each of these is a new **alert source** feeding the same delivery pipeline. They're left out because they're **state-driven**, not event-driven: nothing is emitted when they happen, so they need periodic sweeps plus "alert once per crossing" state.

1. **Relative-cap breach.** Relative caps are checked only on `allocate`, so withdrawals (or losses elsewhere in the vault) can push an id over its cap with **no event**. Example: a $100M vault with $30M in cbBTC (30% cap) loses $40M to withdrawals, leaving $30M of $60M = 50%. Complications:
   - The contract checks against `firstTotalAssets`, a value that exists only during a transaction. We'd use `totalAssets()`, which equals what a transaction would compute right now.
   - We must know each vault's ids, collected from cap events.
   - Alert once on crossing and once on recovery, not on every sweep.
   - Breaches cluster in stress, when withdrawals drain the liquid markets and leave depositors concentrated in the illiquid ones. That's when the alert matters most.
2. **Booked vs live allocation drift.** `caps[id].allocation` only updates on allocate/deallocate (the Morpho API documents this caveat), so interest or bad debt moves real exposure away from what the cap check sees. Live value per id needs Blue share→asset maths with interest accrued to now. Needs per-subscriber thresholds.
3. **Timelock about to expire.** Fire `change.executable` when `executableAt` passes, or N hours before. It's time-driven, and we already store `executableAt`.
4. **Policy-based subscriptions.** "Alert me only if a pending change would break *my* policy" (e.g. a cbBTC cap above $50M, or any timelock under 3 days). That is the trigger an integrator's automated exit would use.
5. **Wider coverage:** all vaults via `CreateVaultV2` factory discovery, other chains (one cursor stream per chain), signed payloads (HMAC) and per-subscriber auth.

## Considered and rejected (as the main build)
| Idea | Why not (for this test) |
|---|---|
| Blue liquidation monitor | Morpho API already exposes `healthFactor`, `priceVariationToLiquidationPrice`, `marketCollateralAtRisk`; liquidation bots cover it; heavy backfill and maths |
| Vault V2 cap tracker (read-only) | API already exposes caps per id, allocations, decoded pending configs, cap history |
| Vault ranking by history/performance | API has APY and share-price history; DefiLlama, vaults.fyi and rating firms exist; ranking weights are opinion; V2 history is short |
| Vault screener ("which vaults meet my policy") | Needs all vaults, full config history and a policy language: a second project built on this one's event log |

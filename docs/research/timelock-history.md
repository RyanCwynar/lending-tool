# Research: Vault V2 timelock activity on Base, and what already exists

Collected 2026-11-15/16 while scoping. Sources: contract source in `reference/vault-v2`, Morpho API schema (introspected for research only; the service does not use the API), docs.morpho.org, and onchain logs via Alchemy.

## 1. What Morpho already exposes

### Morpho API (`api.morpho.org`, GraphQL)
| Concept | Exposed? | Where |
|---|---|---|
| Allocation per risk id, with decoded labels | Yes | `VaultV2.caps[]`: `type`, `data` (Adapter / Collateral / MarketV1), `allocation`, `absoluteCap`, `relativeCap` |
| Booked vs live allocation | Partial | `caps.allocation` is documented as "not always up to date, because interest and losses are accounted only when (de)allocating"; live value only per adapter (`adapter.assets`); no gap field |
| Pending timelocked changes | Yes, decoded | `pendingConfigs[]`: `validAt`, `functionName` (18 values), `decodedData`, `txHash` |
| Timelock durations, abdications | Yes | `timelocks[]`: `duration`, `abdicatedAt` |
| Warnings | Yes | `warnings[]`: timelock too short, bad debt, oracle, low liquidity, unrecognised asset, not whitelisted. **No cap-breach warning.** |
| History | Yes | `historicalState.caps` time series |
| Push / subscriptions | **No** | No GraphQL `Subscription` type |
| Timelock event history (Submit/Accept/Revoke) | **No** | `VaultV2TransactionType` only has Deposit / Withdraw / Transfer |

### Morpho app (from docs and search snippets; the app itself was not loaded)
- Depositor page: an "Exposure" table per market (allocation, liquidity, utilization, APY, absolute and relative cap), roles, timelock *lengths*, warning badges.
- Pending actions are clearly listed in the **Curator App** (Timelocks tab → "Vault Pending Actions"), which is built for operators.
- No headroom rollup, no cap-breach flag, no alerts.
- Third-party alerting exists: Hypernative (commercial) and `yearn/monitoring` (open source, Morpho governance alerts).

**Conclusion:** visibility exists; push delivery from an independent, onchain source is the gap. Hence the timelock watcher.

## 2. RPC findings (relevant to run instructions)
| Endpoint | `eth_getLogs` over history |
|---|---|
| `mainnet.base.org` | Rate-limited immediately (HTTP 429, "request limit reached") |
| `base-rpc.publicnode.com` | "Archive requests require a personal token" |
| `base.drpc.org` (free) | Rejects log queries ("ranges over 10000 blocks are not supported on free plan", even for 1,000 blocks) |
| Alchemy (free key) | Works; 100,000-block ranges accepted |

So live mode needs a keyed provider; the replay fixture removes that need for reviewers.

## 3. Onchain history: 12 largest Base Vault V2s, Oct 2025 → 2026-11-16
Method: one `eth_getLogs` pass for `Submit`/`Accept`/`Revoke` across all 12 vaults (blocks 37,179,342 → 58,258,937; 1,597 events, 15 calls), then pair each `Submit` with its `Accept`/`Revoke` on `(vault, calldata)`.

**808 changes, 0 orphan Accept/Revoke.** The pairing model in PLAN.md holds on real data.

| Vault | Changes | Executed | Revoked | Pending | Zero-notice |
|---|---|---|---|---|---|
| Steakhouse High Yield USDC | 167 | 167 | 0 | 0 | 28 |
| Gauntlet USDC Frontier | 139 | 126 | 2 | 11 | 34 |
| Steakhouse High Yield USDC Edition | 90 | 86 | 4 | 0 | 41 |
| Clearstar cbAssets Vault | 81 | 80 | 0 | 1 | 26 |
| Gauntlet USDC Prime | 75 | 66 | 2 | 7 | 34 |
| Steakhouse Prime USDC | 58 | 58 | 0 | 0 | 26 |
| Grove x Steakhouse USDC | 45 | 45 | 0 | 0 | 36 |
| Ethena x Steakhouse USDC | 44 | 44 | 0 | 0 | 44 |
| KPK USDC Yield | 38 | 38 | 0 | 0 | 33 |
| Splits Earn USDC | 29 | 29 | 0 | 0 | 29 |
| Noon Ecosystem Vault | 25 | 25 | 0 | 0 | 25 |
| Fluidkey USDC Yield by KPK | 17 | 17 | 0 | 0 | 17 |

By function: `increaseAbsoluteCap` 232, `increaseRelativeCap` 212, `increaseTimelock` 124, `setIsAllocator` 79, `abdicate` 54, `setForceDeallocatePenalty` 22, `addAdapter` 17, `setPerformanceFeeRecipient` 11, `setAdapterRegistry` 10, `setPerformanceFee` 9, `decreaseTimelock` 8, `setManagementFee` 6, `setManagementFeeRecipient` 6, `removeAdapter` 5, unknown 13.

**Expected numbers for the 4 demo vaults** (the indexer's acceptance test): 333 changes in total. Steakhouse HY Edition 90 (86 executed / 4 revoked); Gauntlet USDC Frontier 139 (126 / 2 / 11 pending as of block 58,258,937); Gauntlet USDC Prime 75 (66 / 2 / 7); Splits Earn USDC 29 (29 executed).

## 4. Example events (verifiable on BaseScan)
1. **Executed, 3 days' notice.** Steakhouse High Yield USDC Edition: absolute cap on **cbBTC collateral** (and the cbBTC/USDC 86% LLTV market) raised to **500,000,000 USDC**. Submitted 2026-11-09 07:44 UTC, executable 11-12 07:44, executed 11-12 15:02.
   Submit `0x110954fd52ce28366eb2a536f006420d671a2ec6879c5c0cdc1649daae38f7b9` · Accept `0x53cc04bd1588210c409f682d19ee8f79a73ee5544fa741c96da5b427fa05303c`
2. **Revoked after 5 weeks.** Same vault: **syrupUSDC** collateral and market (91.5% LLTV), 100M USDC absolute cap and 100% relative cap. Submitted 2026-08-23, executable 08-26, revoked 09-30 by `0x827e8607…`.
   Submit `0xbae5d112157b0113dc87475a6c8fd888e03df9855e46fbf7dfe10cd873ce5409` · Revoke `0xfa137b501b824da815e994fd94fe1f1f69524464fd4e61746be5c6ee78b3839a`
3. **Revoked "unlimited" adapter cap.** Gauntlet USDC Prime: adapter absolute cap of `type(uint256).max`, submitted 2026-04-29, revoked 05-04 (also on Frontier).
   Prime Submit `0xa5492a58a65b171f9aa69aa12e1485ce47af073cb747676d94ef3efefdee7fb1` · Revoke `0x5b8d2327f3b259300d2635c03bc16eaafa77bd8c82345bd0b3738f83289da2a1`
4. **Pending, executable but not executed.** Gauntlet USDC Frontier: **PAXG** collateral and PAXG/USDC 77% market, caps → 2,000,000 USDC and 100%. Submitted 2026-11-10 23:19, executable since 2026-11-13 23:19.
   Submit `0xb093cf6b6df20e777b6a9a4f2978830d0616ec4ab8672e112b74072c97d6e5e6`
5. **Zero timelock.** Splits Earn USDC: all 29 changes submitted and accepted in the same transaction, e.g. `0x8b5c176b0cc26fda9bcbd9a6f67c5ad75424f4301c5151ae601d547ca1b22a6b`.

## 5. Design lessons (folded into PLAN.md)
1. **Curators bundle changes:** one tx usually submits 4 changes (absolute + relative cap × collateral id + market id), sometimes across several vaults (Steakhouse added mGLO and PAXG caps to two vaults in one tx). Payloads carry `txHash` for grouping.
2. **Execution lags:** changes are accepted 0–61h after becoming executable in the sample, so a `change.executable` alert has real value.
3. **Garbage in the queue:** `submit` accepts any calldata. 13 submissions are of non-timelocked functions (`setName`, `setSymbol`, `setIsSentinel`, `setLiquidityAdapterAndData`) and will stay "pending" forever. Hence the `stale` view and the tolerant decoder.
4. **Unlimited caps:** `type(uint128).max` and `type(uint256).max` appear and must be shown as `unlimited`.
5. **Setup noise:** most zero-notice changes happen during vault setup (timelocks start at 0 and are raised afterwards). The `start_block` rule on subscriptions handles it.
6. **Timelock durations seen:** the largest vaults use 7 days (Grove x Steakhouse, Gauntlet USDC Prime, Steakhouse Prime) or 3 days (Steakhouse High Yield Edition, Clearstar) for cap increases and adapter additions; some smaller vaults use 0.

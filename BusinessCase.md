# Business case: Vault V2 Timelock Watcher

## What we built
A backend service that watches Morpho Vault V2 vaults on Base directly onchain and **pushes signed webhook alerts** when a curator submits, executes or revokes a timelocked change, decoded into plain language: *"Increase absolute cap on collateral cbBTC to 500,000,000 USDC, executable 2026-11-12 07:44."* A GraphQL API shows what is pending, what can execute now and how each delivery went. A replay harness runs 13 months of real Base history through the unmodified service in under three minutes.

## Why it matters to Morpho
- **It makes V2's non-custodial guarantee work in practice.** V2's answer to "what if the curator turns risky?" is the timelock: risk-raising changes are announced days ahead, so depositors can leave first. That only works if someone is watching. Today, noticing means polling the Morpho API, opening the Curator App or reading raw events: nothing tells depositors, or the systems acting for them, when the protection applies.
- **The users who need it are systems.** Coinbase-style integrators, fintechs, treasuries and custodians route large deposits into vaults. Their risk engines need a machine signal ("vault X's cbBTC exposure can rise to $500M on Thursday") to pause deposits or rebalance. Making that easy lowers the cost of integrating V2 for exactly the users who bring TVL.
- **It's real.** The 12 largest Base V2 vaults made 808 timelocked changes since October 2025: cap increases with 3–7 days' notice, a 100M syrupUSDC cap revoked after 5 weeks pending, "unlimited" adapter caps submitted then withdrawn, and vaults with zero timelocks, where notice is impossible.
- **It's independent and easy to adopt.** Each consuming system runs its own copy next to its risk engine, reading the chain itself, with no third party in between. Unlike commercial monitors (e.g. Hypernative), it's an open building block, and it could become part of Morpho's own platform.

## Scope choices
A narrow event pipeline, built carefully: an outbox so alerts are never lost or duplicated, reorg handling, a singleton indexer, SSRF-safe and fair delivery, and secrets encrypted rather than hashed (because they sign). Delivery is deliberately **unordered**: each alert retries on its own, so a failing one never delays a fresh warning, and each carries enough state to be applied in any order. The service can **rewind to any time** and re-process from there. We rejected a liquidation monitor, a cap dashboard and vault rankings because the Morpho API already covers them ([PLAN.md](docs/PLAN.md#considered-and-rejected-as-the-main-build)).

## With more time
1. **State-based alerts on the same pipeline.** *Relative-cap breaches*: relative caps are only checked on allocate, so withdrawals can push a vault over its stated limit with no event, typically in stress, when it matters most. Also allocation drift and "executable within 24h" reminders.
2. **Policy subscriptions:** "alert me only if a pending change would break *my* policy" (a cbBTC cap above $50M, any timelock under 3 days): the trigger an integrator's automated exit needs.
3. **Coverage:** every V2 vault via factory discovery, other chains, all adapter types.
4. **A hosted, self-serve mode:** API keys or Sign-In with Ethereum, per-account ownership, test webhooks, and Slack, Telegram or email behind the same outbox.
5. **A screener:** the event log holds each vault's configuration history, so it can answer "which vaults satisfy my policy right now?", closing the loop from *exit* to *re-entry*.

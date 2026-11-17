/**
 * The GraphiQL demo (http://localhost:4000/graphql): a numbered walkthrough preloaded as tabs.
 *
 * GraphiQL titles each tab with its operation name, hence names like Step3_TheCbBTCStory.
 * GraphiQL keeps tabs in the browser's localStorage and ignores these defaults once it has saved state, so the page
 * clears that state whenever PLAYGROUND_VERSION changes (see graphiqlPage). Bump it when you change the tabs.
 * playground.test.ts validates every query against the schema, so they can't silently rot.
 */
import { renderGraphiQL } from "graphql-yoga";

export const PLAYGROUND_VERSION = "2026-11-16.2";

const CBBTC_TX = "0x110954fd52ce28366eb2a536f006420d671a2ec6879c5c0cdc1649daae38f7b9";
const SYRUP_REVOKE_TX = "0xfa137b501b824da815e994fd94fe1f1f69524464fd4e61746be5c6ee78b3839a";
const STEAKHOUSE_HY_EDITION = "0xbeeff2490feffa212faC2f6553682c219e6a8845".toLowerCase();

export interface PlaygroundTab {
  query: string;
  variables?: string;
}

const tab = (query: string, variables?: Record<string, unknown>): PlaygroundTab => ({
  query: query.trim() + "\n",
  ...(variables ? { variables: JSON.stringify(variables, null, 2) } : {}),
});

export const playgroundTabs: PlaygroundTab[] = [
  tab(`
# ─────────────────────────────────────────────────────────────────────────────
#  Vault V2 Timelock Watcher: demo walkthrough (one tab per step, run with ▶)
# ─────────────────────────────────────────────────────────────────────────────
# Curators must announce risk-raising changes (cap increases, new adapters, fee
# changes) and wait out a timelock before anyone can execute them. This service
# watches Base vaults onchain and pushes signed webhooks when a change is
# SUBMITTED, EXECUTED or REVOKED.
#
#  Step 1  is it healthy, and how far behind the chain?       (this tab)
#  Step 2  what could execute right now?
#  Step 3  the cbBTC story: a $500M cap increase, 3 days' notice
#  Step 4  the curator who backed down (revoked after 5 weeks)
#  Step 5  time travel: what was pending on any date
#  Step 6  who is subscribed, and how their deliveries are going
#  Step 7  the delivery trail of one alert (retries, failures)
#  Step 8  alerts that gave up after 8 attempts
#  Step 9  junk in the queue: "pending" changes that can never execute
#  Step 10 one vault's full curator history
#  Step 11 subscribe your own webhook / Step 12 unsubscribe
#
# Demo data: the offline stack replays real Base history (Oct 2025 → Nov 2026).
# Move the mock chain from a terminal, then re-run Step 2 or Step 5:
#   curl -XPOST 'localhost:8545/control/advance-to?time=2026-11-10T00:00:00Z'
#   curl -XPOST 'localhost:8545/control/play?speed=1d/2s'
# (with the demo's alternate ports, 8545 may be 18546)
# lagBlocks includes the confirmation depth (10). chainTime = the service's "now".
query Step1_IsItHealthy {
  health {
    ok
    database { ok }
    rpc { ok chainId blockNumber }
    indexer { lastBlock headBlock lagBlocks chainTime }
  }
  vaults { name pendingCount }
}`),

  tab(`
# What could execute right now? Pending, past its timelock, and not stale junk.
# "executable" uses chain time, exactly like the contract (block.timestamp).
query Step2_WhatCanExecuteNow {
  timelockChanges(status: PENDING, stale: false) {
    vault { name }
    summary
    submittedAt
    executableAt
    executable
  }
}`),

  tab(
    `
# Steakhouse High Yield USDC Edition raised its cbBTC caps to 500M USDC.
# Curators bundle changes: one tx = absolute cap on the collateral AND the market.
# Subscribers got 3 days' notice (submittedAt → executableAt) before it executed.
query Step3_TheCbBTCStory($tx: String!) {
  timelockChanges(txHash: $tx) {
    vault { name }
    summary
    status
    submittedAt
    executableAt
    resolvedAt
    deliveries { eventType status attempts subscription { url } }
  }
}`,
    { tx: CBBTC_TX },
  ),

  tab(
    `
# A 100M USDC cap on a syrupUSDC market (91.5% LLTV) was submitted on 2026-08-23
# and revoked five weeks later. Subscribers heard both ends of the story.
query Step4_CuratorBackedDown($tx: String!) {
  timelockChanges(txHash: $tx) {
    vault { name }
    summary
    status
    submittedAt
    executableAt
    resolvedAt
    revokedBy
  }
  allRevoked: timelockChanges(status: REVOKED) { vault { name } summary resolvedAt }
}`,
    { tx: SYRUP_REVOKE_TX },
  ),

  tab(
    `
# Time travel: what was pending at any moment? Try other dates.
# 2026-09-15: the syrupUSDC caps from Step 4 were still pending.
query Step5_PendingOnADate($at: String!) {
  timelockChanges(pendingAt: $at) {
    vault { name }
    summary
    submittedAt
    executableAt
    status
  }
}`,
    { at: "2026-09-15T00:00:00Z" },
  ),

  tab(`
# Who is subscribed, and how are their deliveries going?
# In the demo: /ok always answers 200, /flaky fails twice then succeeds,
# /down always fails, /slow answers after the 5s timeout (Splits vault only).
query Step6_Subscribers {
  subscriptions {
    url
    vaults
    functions
    active
    deliveryCounts { delivered pending failed }
  }
}`),

  tab(
    `
# Every webhook one change caused: per subscriber, how many attempts and why.
# /flaky shows 3 attempts then DELIVERED; /down shows 8 attempts then FAILED.
query Step7_DeliveryTrail($tx: String!) {
  timelockChanges(txHash: $tx, functionName: "increaseAbsoluteCap") {
    summary
    deliveries {
      eventType
      status
      attempts
      lastStatusCode
      lastError
      deliveredAt
      subscription { url }
    }
  }
}`,
    { tx: CBBTC_TX },
  ),

  tab(`
# Alerts that gave up after the last retry (30s, 2m, 10m, 1h, 3h, 6h, 12h).
query Step8_FailedDeliveries {
  deliveries(status: FAILED, limit: 10) {
    eventType
    attempts
    lastStatusCode
    lastError
    subscription { url }
  }
}`),

  tab(`
# "Pending" isn't always meaningful: submit() accepts ANY calldata, and real vaults
# have setName/setSymbol submissions (not timelocked functions) pending for a year.
# The service keeps them, flags them, and the stale filter hides them from Step 2.
query Step9_JunkInTheQueue {
  timelockChanges(stale: true) {
    vault { name }
    functionName
    isTimelockedFunction
    summary
    executableAt
  }
}`),

  tab(
    `
# One vault's full curator history, newest first, with decoded risk ids.
query Step10_VaultHistory($vault: String!) {
  vault(address: $vault) {
    name
    pendingCount
    changes(limit: 40) {
      status
      summary
      submittedAt
      executableAt
      resolvedAt
    }
  }
}`,
    { vault: STEAKHOUSE_HY_EDITION },
  ),

  tab(
    `
# Subscribe a webhook. The signing secret is returned ONCE (stored encrypted).
# Filters: vaults and timelocked function names. Alerts start from the next block,
# so run this, then move the mock chain (see Step 1) to watch deliveries arrive.
mutation Step11_Subscribe($input: CreateSubscriptionInput!) {
  createSubscription(input: $input) {
    secret
    subscription { id url functions startBlock }
  }
}`,
    {
      input: {
        url: "http://mock-receivers:9000/ok?sub=playground",
        functions: ["increaseAbsoluteCap", "increaseRelativeCap", "addAdapter"],
      },
    },
  ),

  tab(
    `
# Stop a subscription. Paste an id from Step 6 or Step 11.
mutation Step12_Unsubscribe($id: ID!) {
  deactivateSubscription(id: $id) { id url active }
}`,
    { id: "paste-a-subscription-id" },
  ),
];

/**
 * The GraphiQL page: Yoga's renderer plus a tiny script that clears GraphiQL's saved tabs once per
 * PLAYGROUND_VERSION, so every visitor gets the walkthrough tabs (instead of whatever their browser saved earlier)
 * and later edits are kept as usual. It also drops a stale ?query= from the URL, which GraphiQL would otherwise
 * open as an extra "<untitled>" tab.
 */
export function graphiqlPage(options: Parameters<typeof renderGraphiQL>[0]): string {
  const reset = `<script>(function(){try{var k="watcher:playground-version",v=${JSON.stringify(PLAYGROUND_VERSION)};
if(localStorage.getItem(k)!==v){Object.keys(localStorage).forEach(function(x){if(x.indexOf("graphiql:")===0)localStorage.removeItem(x)});
localStorage.setItem(k,v);var u=new URL(location.href);if(u.searchParams.has("query")){u.searchParams.delete("query");history.replaceState({},"",u)}}}catch(e){}})();</script>`;
  const html = renderGraphiQL(options);
  // Must run before GraphiQL reads storage: put it at the very start of <head>.
  return html.includes("<head>") ? html.replace("<head>", `<head>${reset}`) : reset + html;
}

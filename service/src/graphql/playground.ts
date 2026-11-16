/**
 * Saved queries preloaded into GraphiQL (http://localhost:4000/graphql) as tabs.
 * GraphiQL uses these only when the browser has no saved tab state for this page; to get them back after
 * editing tabs, clear the site's storage or open a private window.
 * playground.test.ts validates every query against the schema, so they can't silently rot.
 */

const STEAKHOUSE_HY_EDITION = "0xbeeff2490feffa212fac2f6553682c219e6a8845";

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
# Is the service healthy, and how far behind the chain is the indexer?
# lagBlocks includes the CONFIRMATIONS depth (10 by default). chainTime is the service's notion of "now".
query Health {
  health {
    ok
    database { ok error }
    rpc { ok chainId blockNumber error }
    indexer { lastBlock headBlock lagBlocks chainTime updatedAt }
  }
}`),

  tab(`
# What can happen right now? Pending changes past their timelock that aren't old junk.
# "executable" = anyone can execute it now (chain time >= executableAt).
query ActionableNow {
  timelockChanges(status: PENDING, stale: false) {
    vault { name }
    summary
    submittedAt
    executableAt
    executable
    submitTx
  }
}`),

  tab(`
# Every watched vault, with how many changes are pending.
query Vaults {
  vaults {
    name
    address
    assetSymbol
    startBlock
    pendingCount
  }
}`),

  tab(
    `
# Full curator history of one vault, newest first.
query VaultHistory($vault: String!) {
  vault(address: $vault) {
    name
    pendingCount
    changes(limit: 50) {
      status
      summary
      submittedAt
      executableAt
      resolvedAt
      submitTx
      resolvedTx
    }
  }
}`,
    { vault: STEAKHOUSE_HY_EDITION },
  ),

  tab(
    `
# Time travel: what was pending at a given moment?
# 2026-09-15: the syrupUSDC market caps on Steakhouse High Yield USDC Edition were pending (later revoked).
query PendingAt($at: String!) {
  timelockChanges(pendingAt: $at) {
    vault { name }
    summary
    submittedAt
    executableAt
    status
    resolvedAt
  }
}`,
    { at: "2026-09-15T00:00:00Z" },
  ),

  tab(`
# Changes a curator submitted and then withdrew.
query Revoked {
  timelockChanges(status: REVOKED) {
    vault { name }
    summary
    submittedAt
    resolvedAt
    revokedBy
    resolvedTx
  }
}`),

  tab(`
# Stale "pending" changes: past executableAt by more than STALE_AFTER_DAYS.
# Many aren't timelocked functions at all (e.g. setName): submit() accepts any calldata, so they can never execute.
query StaleJunk {
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
# Only one kind of change, e.g. absolute cap increases, with the decoded risk id and amount.
query ByFunction($fn: String!) {
  timelockChanges(functionName: $fn, limit: 25) {
    vault { name }
    status
    summary
    decoded
    executableAt
  }
}`,
    { fn: "increaseAbsoluteCap" },
  ),

  tab(`
# One change and every webhook delivery it caused (attempts, status codes, errors).
query ChangeWithDeliveries {
  timelockChanges(status: REVOKED, limit: 1) {
    id
    vault { name }
    summary
    deliveries {
      eventType
      status
      attempts
      lastStatusCode
      lastError
      deliveredAt
      subscriptionId
    }
  }
}`),

  tab(`
# Subscribers and how their deliveries are going.
query Subscriptions {
  subscriptions {
    id
    url
    vaults
    functions
    startBlock
    active
    deliveryCounts { pending delivered failed }
  }
}`),

  tab(`
# Deliveries that gave up after the last retry: what went wrong?
query FailedDeliveries {
  deliveries(status: FAILED, limit: 20) {
    subscriptionId
    eventType
    attempts
    lastStatusCode
    lastError
    nextAttemptAt
  }
}`),

  tab(
    `
# Subscribe a webhook. The secret is returned ONCE: the receiver uses it to verify X-Signature.
# In the demo, mock-receivers accepts /ok, /flaky, /down and /slow (register the secret with
# POST localhost:9000/control/register to see signatures verified). Alerts start from the next indexed block.
mutation Subscribe($input: CreateSubscriptionInput!) {
  createSubscription(input: $input) {
    secret
    subscription { id url vaults functions startBlock }
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
# Stop a subscription (its queued deliveries are marked failed rather than sent).
mutation Unsubscribe($id: ID!) {
  deactivateSubscription(id: $id) { id active }
}`,
    { id: "paste-a-subscription-id" },
  ),
];

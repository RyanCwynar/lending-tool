/**
 * End-to-end: mock-rpc (recorded Base history) → indexer → outbox → worker → mock receivers, with subscriptions
 * created through the GraphQL API and results read back through it. Covers tasks 7–11 in docs/TASKS.md.
 * The worker and receivers share an injected clock, so the 8-attempt retry schedule (~22h) runs in seconds.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { createYoga } from "graphql-yoga";
import { createRpcClient } from "./rpc/client.js";
import { schema, type GraphQLContext } from "./graphql/schema.js";
import { ChainReader } from "./indexer/chain-reader.js";
import { Indexer } from "./indexer/indexer.js";
import { DeliveryWorker, RETRY_SCHEDULE_SECONDS } from "./delivery/worker.js";
import { createMockReceivers } from "./harness/mock-receivers.js";
import { TEST_DATABASE_URL, freshDatabase, silentLog, startMockRpc, testConfig, vaultsEnv } from "./test/harness.js";

const ALL_ALERTS = 648; // 333 submitted + 315 executed/revoked across the 4 demo vaults (research §3)

describe.skipIf(!TEST_DATABASE_URL)("end to end", () => {
  let db: Awaited<ReturnType<typeof freshDatabase>>;
  let rpc: Awaited<ReturnType<typeof startMockRpc>>;
  let receivers: ReturnType<typeof createMockReceivers>;
  let receiversUrl: string;
  let gql: <T = any>(query: string, variables?: Record<string, unknown>) => Promise<T>;
  let indexer: Indexer;
  let worker: DeliveryWorker;
  let clock = Date.now() + 1000; // ms, shared by worker and receivers
  const key = randomBytes(32);
  const subs: Record<string, string> = {};

  beforeAll(async () => {
    db = await freshDatabase();
    rpc = await startMockRpc();
    receivers = createMockReceivers(undefined, { slowMs: 1500, now: () => Math.floor(clock / 1000) });
    await new Promise<void>((r) => receivers.server.listen(0, "127.0.0.1", r));
    receiversUrl = `http://127.0.0.1:${(receivers.server.address() as AddressInfo).port}`;

    const config = testConfig({
      VAULTS: vaultsEnv(rpc.fixture),
      CONFIRMATIONS: "0",
      LOG_RANGE: "500000",
      WEBHOOK_ALLOW_PRIVATE: "true",
      SECRET_ENCRYPTION_KEY: key.toString("base64"),
    });
    const client = createRpcClient(rpc.url);
    const ctx: GraphQLContext = { pool: db.pool, rpc: client, config, encryptionKey: key };
    const yoga = createYoga({ schema, context: () => ctx, maskedErrors: false });
    gql = async (query, variables) => {
      const res = await yoga.fetch("http://test/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });
      const json = (await res.json()) as { data?: any; errors?: { message: string }[] };
      if (json.errors) throw new Error(json.errors.map((e) => e.message).join("; "));
      return json.data;
    };
    indexer = new Indexer(db.pool, new ChainReader(client), config, silentLog);
    await indexer.init();
    worker = new DeliveryWorker(
      db.pool,
      { encryptionKey: key, maxAttempts: 8, timeoutMs: 500, concurrency: 64, perSubscription: 64, allowPrivate: true, now: () => new Date(clock) },
      silentLog,
    );
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((r) => receivers?.server.close(() => r()));
    await rpc?.close();
    await db?.drop();
  });

  it("creates subscriptions through the API and validates input", async () => {
    const create = `mutation($input: CreateSubscriptionInput!) {
      createSubscription(input: $input) { secret subscription { id startBlock } } }`;
    const splits = rpc.fixture.vaults.find((v) => v.name === "Splits Earn USDC")!.address;
    for (const [name, input] of Object.entries({
      ok: { url: `${receiversUrl}/ok` },
      flaky: { url: `${receiversUrl}/flaky` },
      down: { url: `${receiversUrl}/down` },
      slow: { url: `${receiversUrl}/slow`, vaults: [splits] },
      adaptersOnly: { url: `${receiversUrl}/ok?sub=adapters`, functions: ["addAdapter"] },
    })) {
      const r = await gql(create, { input });
      subs[name] = r.createSubscription.subscription.id;
      expect(r.createSubscription.secret).toMatch(/^whsec_/);
      // start_block = chain head now (no cursor yet), i.e. before every vault existed: the whole history is "new".
      expect(Number(r.createSubscription.subscription.startBlock)).toBeLessThan(rpc.fixture.fromBlock);
      const u = new URL(input.url);
      await fetch(`${receiversUrl}/control/register`, {
        method: "POST",
        body: JSON.stringify({ path: `${u.pathname}${u.search}`, secret: r.createSubscription.secret }),
      });
    }
    await expect(gql(create, { input: { url: "ftp://x" } })).rejects.toThrow(/url rejected/);
    await expect(gql(create, { input: { url: `${receiversUrl}/ok`, functions: ["setName"] } })).rejects.toThrow(/unknown timelocked function/);
  });

  it("indexes the full history and queues one alert per event per matching subscriber", async () => {
    rpc.chain.advanceTo({ block: rpc.fixture.toBlock });
    for (let i = 0; i < 1000 && (await indexer.tick()).kind !== "waiting"; i++);
    const r = await db.pool.query<{ subscription_id: string; n: number }>(
      "SELECT subscription_id, count(*)::int AS n FROM delivery GROUP BY subscription_id",
    );
    const counts = Object.fromEntries(r.rows.map((x) => [x.subscription_id, x.n]));
    expect(counts[subs.ok!]).toBe(ALL_ALERTS);
    expect(counts[subs.flaky!]).toBe(ALL_ALERTS);
    expect(counts[subs.down!]).toBe(ALL_ALERTS);
    expect(counts[subs.slow!]).toBe(58); // Splits Earn USDC: 29 submitted + 29 executed
    const adapterChanges = await db.pool.query("SELECT count(*)::int AS n, count(resolved_block)::int AS r FROM timelock_change WHERE function_name = 'addAdapter'");
    expect(counts[subs.adaptersOnly!]).toBe(adapterChanges.rows[0].n + adapterChanges.rows[0].r);
  }, 120_000);

  it("answers visibility queries: pending now, stale, and what was pending at a past moment", async () => {
    const pending = await gql(`{ timelockChanges(status: PENDING, limit: 1000) { id summary executable stale isTimelockedFunction } }`);
    expect(pending.timelockChanges).toHaveLength(18); // 11 Frontier + 7 Prime
    expect(pending.timelockChanges.some((c: any) => c.summary === "Increase absolute cap on collateral PAXG to 2,000,000 USDC")).toBe(true);
    const stale = await gql(`{ timelockChanges(stale: true, limit: 1000) { summary isTimelockedFunction } }`);
    expect(stale.timelockChanges.some((c: any) => !c.isTimelockedFunction)).toBe(true); // junk like setName pending for a year

    // The syrupUSDC market changes were pending from 2026-08-23 until they were revoked on 2026-09-30.
    const then = await gql(`{ timelockChanges(pendingAt: "2026-09-15T00:00:00Z", limit: 1000) { summary status vault { name } } }`);
    const syrup = then.timelockChanges.filter((c: any) => c.summary.includes("syrupUSDC") && c.vault.name === "Steakhouse High Yield USDC Edition");
    expect(syrup.length).toBe(4);
    expect(syrup.every((c: any) => c.status === "REVOKED")).toBe(true);

    const health = await gql(`{ health { ok indexer { lastBlock lagBlocks chainTime } } }`);
    expect(Number(health.health.indexer.lastBlock)).toBe(rpc.fixture.toBlock);
    expect(health.health.indexer.lagBlocks).toBe("0");
  });

  it("delivers signed alerts; a slow receiver times out without blocking the others", async () => {
    // Start the shared clock after indexing, so every queued delivery is already due on the first pass.
    clock = Date.now() + 1000;
    while ((await worker.runOnce()) > 0);
    const s = receivers.state.summary();
    expect(s["/ok"]!.accepted).toBe(ALL_ALERTS + (await countFor(subs.adaptersOnly!)));
    expect(s["/ok"]!.badSignatures).toBe(0);
    expect(s["/flaky"]!.accepted).toBe(0); // first attempt always fails
    const slow = await db.pool.query("SELECT DISTINCT last_error FROM delivery WHERE subscription_id = $1", [subs.slow]);
    expect(slow.rows.map((r) => r.last_error)).toEqual([expect.stringMatching(/timeout/)]);
  }, 120_000);

  it("retries on the backoff schedule: flaky succeeds on attempt 3, down fails after 8 attempts", async () => {
    for (const delay of RETRY_SCHEDULE_SECONDS) {
      clock += (delay + 1) * 1000;
      while ((await worker.runOnce()) > 0);
    }
    const byStatus = async (sub: string) =>
      Object.fromEntries(
        (await db.pool.query("SELECT status, count(*)::int AS n, max(attempts) AS a FROM delivery WHERE subscription_id = $1 GROUP BY status", [sub])).rows.map((r) => [r.status, { n: r.n, maxAttempts: r.a }]),
      );
    expect(await byStatus(subs.flaky!)).toEqual({ DELIVERED: { n: ALL_ALERTS, maxAttempts: 3 } });
    expect(await byStatus(subs.down!)).toEqual({ FAILED: { n: ALL_ALERTS, maxAttempts: 8 } });
    expect(await byStatus(subs.slow!)).toEqual({ FAILED: { n: 58, maxAttempts: 8 } });
    const s = receivers.state.summary();
    expect(s["/flaky"]!.accepted).toBe(ALL_ALERTS);
    expect(s["/flaky"]!.requests).toBe(ALL_ALERTS * 3);
    expect(s["/down"]!.requests).toBe(ALL_ALERTS * 8);
    expect(s["/ok"]!.duplicatesAfterAccept).toBe(0);

    const api = await gql(`query($id: ID!) { deliveries(subscriptionId: $id, status: FAILED, limit: 1) { attempts lastStatusCode lastError } }`, { id: subs.down });
    expect(api.deliveries[0]).toEqual({ attempts: 8, lastStatusCode: 500, lastError: "HTTP 500" });
  }, 180_000);

  it("re-indexing after a lost cursor queues no duplicate alerts", async () => {
    const before = (await db.pool.query("SELECT count(*)::int AS n FROM delivery")).rows[0].n;
    const start = Math.min(...rpc.fixture.vaults.map((v) => v.startBlock)) - 1;
    const b = await new ChainReader(createRpcClient(rpc.url)).block(start);
    await db.pool.query("UPDATE sync_cursor SET last_block = $1, block_hash = $2", [start, Buffer.from(b.hash.slice(2), "hex")]);
    for (let i = 0; i < 1000 && (await indexer.tick()).kind !== "waiting"; i++);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM delivery")).rows[0].n).toBe(before);
  }, 120_000);

  async function countFor(sub: string) {
    return (await db.pool.query("SELECT count(*)::int AS n FROM delivery WHERE subscription_id = $1", [sub])).rows[0].n as number;
  }
});

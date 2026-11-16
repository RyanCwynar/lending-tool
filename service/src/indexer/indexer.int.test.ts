/**
 * Indexer acceptance test (docs/TASKS.md, task 6): replaying the recorded fixture must reproduce exactly the
 * numbers counted independently in docs/research/timelock-history.md §3, and replaying again must add nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createRpcClient } from "../rpc/client.js";
import { ChainReader } from "./chain-reader.js";
import { Indexer } from "./indexer.js";
import { TEST_DATABASE_URL, freshDatabase, silentLog, startMockRpc, testConfig, vaultsEnv } from "../test/harness.js";

const EXPECTED: Record<string, { total: number; EXECUTED: number; REVOKED: number; PENDING: number }> = {
  "Steakhouse High Yield USDC Edition": { total: 90, EXECUTED: 86, REVOKED: 4, PENDING: 0 },
  "Gauntlet USDC Frontier": { total: 139, EXECUTED: 126, REVOKED: 2, PENDING: 11 },
  "Gauntlet USDC Prime": { total: 75, EXECUTED: 66, REVOKED: 2, PENDING: 7 },
  "Splits Earn USDC": { total: 29, EXECUTED: 29, REVOKED: 0, PENDING: 0 },
};

describe.skipIf(!TEST_DATABASE_URL)("indexer against mock-rpc + Postgres", () => {
  let db: Awaited<ReturnType<typeof freshDatabase>>;
  let rpc: Awaited<ReturnType<typeof startMockRpc>>;
  let indexer: Indexer;

  async function runToHead() {
    for (let i = 0; i < 10_000; i++) {
      const r = await indexer.tick();
      if (r.kind === "waiting") return;
    }
    throw new Error("indexer did not catch up");
  }

  async function counts(pool: pg.Pool) {
    const r = await pool.query<{ name: string; status: string; n: string }>(
      `SELECT v.name, c.status, count(*) AS n FROM timelock_change c JOIN vault v ON v.address = c.vault
        GROUP BY v.name, c.status`,
    );
    const out: Record<string, { total: number; EXECUTED: number; REVOKED: number; PENDING: number }> = {};
    for (const row of r.rows) {
      const o = (out[row.name] ??= { total: 0, EXECUTED: 0, REVOKED: 0, PENDING: 0 });
      o[row.status as "EXECUTED"] = Number(row.n);
      o.total += Number(row.n);
    }
    return out;
  }

  beforeAll(async () => {
    db = await freshDatabase();
    rpc = await startMockRpc();
    rpc.chain.advanceTo({ block: rpc.fixture.toBlock });
    const config = testConfig({ VAULTS: vaultsEnv(rpc.fixture), CONFIRMATIONS: "0", LOG_RANGE: "200000" });
    indexer = new Indexer(db.pool, new ChainReader(createRpcClient(rpc.url)), config, silentLog);
    await indexer.init();
  }, 60_000);

  afterAll(async () => {
    await rpc?.close();
    await db?.drop();
  });

  it("reproduces the research counts exactly", async () => {
    await runToHead();
    expect(await counts(db.pool)).toEqual(EXPECTED);
    const events = await db.pool.query("SELECT count(*)::int AS n FROM vault_event");
    expect(events.rows[0].n).toBe(rpc.fixture.logs.length); // 648: every log stored once
    const cursor = await db.pool.query("SELECT last_block FROM sync_cursor");
    expect(Number(cursor.rows[0].last_block)).toBe(rpc.fixture.toBlock);
  }, 120_000);

  it("labels changes with token symbols and amounts", async () => {
    const r = await db.pool.query(
      "SELECT decoded->>'summary' AS s FROM timelock_change WHERE submitted_tx = $1 ORDER BY id",
      ["0x110954fd52ce28366eb2a536f006420d671a2ec6879c5c0cdc1649daae38f7b9"],
    );
    expect(r.rows.map((x) => x.s)).toContain("Increase absolute cap on collateral cbBTC to 500,000,000 USDC");
  });

  it("re-indexing the whole range adds nothing (idempotent)", async () => {
    const before = await counts(db.pool);
    // Simulate a crash/restart that lost the cursor: rewind it to the start and index everything again.
    await db.pool.query("UPDATE sync_cursor SET last_block = (SELECT min(start_block) - 1 FROM vault)");
    const startHash = await db.pool.query("SELECT block_hash FROM sync_cursor");
    expect(startHash.rowCount).toBe(1);
    // The stored hash belonged to the old cursor block, so put the right one back to avoid a reorg rewind.
    const reader = new ChainReader(createRpcClient(rpc.url));
    const start = Math.min(...rpc.fixture.vaults.map((v) => v.startBlock)) - 1;
    const b = await reader.block(start);
    await db.pool.query("UPDATE sync_cursor SET block_hash = $1", [Buffer.from(b.hash.slice(2), "hex")]);
    await runToHead();
    expect(await counts(db.pool)).toEqual(before);
    const events = await db.pool.query("SELECT count(*)::int AS n FROM vault_event");
    expect(events.rows[0].n).toBe(rpc.fixture.logs.length);
  }, 120_000);

  it("halves the log range when the provider rejects it, and still gets every event", async () => {
    const db2 = await freshDatabase();
    try {
      rpc.chain.faults = { rate429: 0, rangeLimit: 50_000, timeoutRate: 0 };
      const config = testConfig({ VAULTS: vaultsEnv(rpc.fixture), CONFIRMATIONS: "0", LOG_RANGE: "200000" });
      const idx = new Indexer(db2.pool, new ChainReader(createRpcClient(rpc.url)), config, silentLog);
      await idx.init();
      let rejections = 0;
      for (let i = 0; i < 10_000; i++) {
        const r = await idx.tick();
        if (r.kind === "waiting") {
          const cur = await db2.pool.query("SELECT last_block FROM sync_cursor");
          if (Number(cur.rows[0]?.last_block) >= rpc.fixture.toBlock) break;
          rejections++;
        }
      }
      expect(rejections).toBeGreaterThan(0);
      expect(await counts(db2.pool)).toEqual(EXPECTED);
    } finally {
      rpc.chain.faults = { rate429: 0, rangeLimit: null, timeoutRate: 0 };
      await db2.drop();
    }
  }, 180_000);

  it("rewinds and re-indexes after a reorg (stored cursor hash no longer canonical)", async () => {
    const before = await counts(db.pool);
    // The hash check runs when there is new work, so step the cursor back a little and corrupt its hash:
    // that is what the indexer sees when the block it last processed was replaced.
    await db.pool.query("UPDATE sync_cursor SET last_block = last_block - 1000, block_hash = $1", [Buffer.alloc(32, 7)]);
    const r = await indexer.tick();
    expect(r.kind).toBe("reorg");
    await runToHead();
    expect(await counts(db.pool)).toEqual(before);
  }, 120_000);
});

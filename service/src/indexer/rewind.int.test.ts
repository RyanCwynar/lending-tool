/**
 * Rewinding to a time must leave the database exactly as if the indexer had only ever indexed up to that time,
 * and the indexer must then re-index forward to the same final state. Also: a tick that overlaps a rewind must
 * not move the cursor over the rewound range.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createRpcClient } from "../rpc/client.js";
import { ChainReader } from "./chain-reader.js";
import { Indexer } from "./indexer.js";
import { rewindToTime } from "./rewind.js";
import { TEST_DATABASE_URL, freshDatabase, silentLog, startMockRpc, testConfig, vaultsEnv } from "../test/harness.js";

// Mid-history: some changes submitted before T are resolved after it, so the rewind must reopen them.
const T = "2026-06-01T00:00:00Z";

describe.skipIf(!TEST_DATABASE_URL)("rewind to a time", () => {
  let rpc: Awaited<ReturnType<typeof startMockRpc>>;
  const dbs: Awaited<ReturnType<typeof freshDatabase>>[] = [];

  beforeAll(async () => {
    rpc = await startMockRpc();
  }, 60_000);

  afterAll(async () => {
    await rpc?.close();
    for (const d of dbs) await d.drop();
  });

  async function setup() {
    const db = await freshDatabase();
    dbs.push(db);
    const config = testConfig({ VAULTS: vaultsEnv(rpc.fixture), CONFIRMATIONS: "0", LOG_RANGE: "200000" });
    const reader = new ChainReader(createRpcClient(rpc.url));
    const indexer = new Indexer(db.pool, reader, config, silentLog);
    await indexer.init();
    // One catch-all subscription from the very start, so every change produces deliveries.
    await db.pool.query(
      `INSERT INTO subscription (url, start_block, secret_ciphertext, secret_iv, secret_tag)
       VALUES ('http://receiver.test/ok', 0, '\\x00', '\\x00', '\\x00')`,
    );
    return { db, config, reader, indexer };
  }

  async function runToHead(indexer: Indexer) {
    for (let i = 0; i < 10_000; i++) if ((await indexer.tick()).kind === "waiting") return;
    throw new Error("indexer did not catch up");
  }

  /** Everything chain-derived, in a form that doesn't depend on serial ids or delivery uuids. */
  async function snapshot(pool: pg.Pool) {
    const q = async (sql: string) => (await pool.query(sql)).rows;
    return {
      cursor: await q("SELECT last_block, block_hash, block_timestamp FROM sync_cursor"),
      events: await q("SELECT tx_hash, log_index, event_name, block_number FROM vault_event ORDER BY tx_hash, log_index"),
      changes: await q(
        `SELECT vault, submitted_tx, status, resolved_tx, resolved_block, revoked_by, decoded->>'summary' AS summary
           FROM timelock_change ORDER BY submitted_tx, vault, data, status`,
      ),
      deliveries: await q(
        `SELECT c.submitted_tx, c.vault, c.data, d.event_type, d.block_number
           FROM delivery d JOIN timelock_change c ON c.id = d.change_id
          ORDER BY c.submitted_tx, c.vault, c.data, d.event_type`,
      ),
    };
  }

  it("leaves the same state as indexing only up to that time, then re-indexes to the same end state", async () => {
    // A: index all of history, and pretend every alert was delivered (a rewind must forget those too).
    rpc.chain.advanceTo({ block: rpc.fixture.toBlock });
    const a = await setup();
    await runToHead(a.indexer);
    const full = await snapshot(a.db.pool);
    await a.db.pool.query("UPDATE delivery SET status = 'DELIVERED', delivered_at = now()");

    // B: index only up to T.
    rpc.chain.advanceTo({ time: Date.parse(T) / 1000 });
    const b = await setup();
    await runToHead(b.indexer);
    const upToT = await snapshot(b.db.pool);
    expect(upToT.changes.some((c) => c.status === "PENDING")).toBe(true);

    // Rewind A to T (mock-rpc's clock already moved back, as in the demo).
    const r = await rewindToTime(a.db.pool, a.reader, a.config, new Date(T));
    expect(r.kind).toBe("rewound");
    if (r.kind !== "rewound") return;
    expect(r.undone.reopened).toBeGreaterThan(0);
    expect(r.undone.events).toBe(full.events.length - upToT.events.length);
    expect(await snapshot(a.db.pool)).toEqual(upToT);
    // Alerts from before T are untouched (still delivered); every alert after T is gone.
    const kept = await a.db.pool.query("SELECT status, count(*)::int AS n FROM delivery GROUP BY status");
    expect(kept.rows).toEqual([{ status: "DELIVERED", n: upToT.deliveries.length }]);

    // Rewinding again to the same time is a no-op.
    expect((await rewindToTime(a.db.pool, a.reader, a.config, new Date(T))).kind).toBe("noop");

    // Play forward again: same end state as never having rewound, and every alert after T is queued again.
    rpc.chain.advanceTo({ block: rpc.fixture.toBlock });
    await runToHead(a.indexer);
    expect(await snapshot(a.db.pool)).toEqual(full);
    const requeued = await a.db.pool.query("SELECT count(*)::int AS n FROM delivery WHERE status = 'PENDING'");
    expect(requeued.rows[0].n).toBe(full.deliveries.length - upToT.deliveries.length);
  }, 300_000);

  it("a tick that overlaps a rewind rolls back instead of skipping the rewound range", async () => {
    rpc.chain.advanceTo({ time: Date.parse(T) / 1000 });
    const a = await setup();
    await runToHead(a.indexer);
    rpc.chain.advanceTo({ block: rpc.fixture.toBlock });

    const cursor = Number((await a.db.pool.query("SELECT last_block FROM sync_cursor")).rows[0].last_block);
    const back = cursor - 1000;
    const backBlock = await a.reader.block(back);

    // A concurrent "rewind": move the cursor back inside an open transaction, holding the row lock.
    const other = await a.db.pool.connect();
    try {
      await other.query("BEGIN");
      await other.query("UPDATE sync_cursor SET last_block = $1, block_hash = $2", [back, Buffer.from(backBlock.hash.slice(2), "hex")]);
      // The tick read the old cursor (the update isn't committed), so it indexes from there and then blocks on the row.
      const tick = a.indexer.tick();
      for (let i = 0; i < 200; i++) {
        const w = await a.db.pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
        );
        if (w.rowCount) break;
        await new Promise((res) => setTimeout(res, 50));
      }
      await other.query("COMMIT");
      expect((await tick).kind).toBe("waiting");
    } finally {
      other.release();
    }
    const after = await a.db.pool.query("SELECT last_block FROM sync_cursor");
    expect(Number(after.rows[0].last_block)).toBe(back);
    // Nothing from the overlapping tick's range was kept.
    const above = await a.db.pool.query("SELECT count(*)::int AS n FROM vault_event WHERE block_number > $1", [cursor]);
    expect(above.rows[0].n).toBe(0);
  }, 300_000);
});

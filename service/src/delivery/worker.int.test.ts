/**
 * Regression test for head-of-line blocking (found by the replay demo): a slow receiver must not delay deliveries
 * to other subscribers. The worker keeps a continuous pool and caps in-flight deliveries per subscription.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { DeliveryWorker } from "./worker.js";
import { encryptSecret, generateSecret } from "./secrets.js";
import { createMockReceivers } from "../harness/mock-receivers.js";
import { TEST_DATABASE_URL, freshDatabase, silentLog } from "../test/harness.js";

describe.skipIf(!TEST_DATABASE_URL)("delivery worker fairness", () => {
  let db: Awaited<ReturnType<typeof freshDatabase>>;
  let receivers: ReturnType<typeof createMockReceivers>;
  let base: string;
  const key = randomBytes(32);

  beforeAll(async () => {
    db = await freshDatabase();
    receivers = createMockReceivers(undefined, { slowMs: 3000 });
    await new Promise<void>((r) => receivers.server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(receivers.server.address() as AddressInfo).port}`;

    // Minimal chain data so deliveries have something to point at.
    const vault = "0x" + "11".repeat(20);
    const hash = "0x" + "22".repeat(32);
    await db.pool.query("INSERT INTO vault (address, chain_id, start_block) VALUES ($1, 8453, 1)", [vault]);
    const ev = await db.pool.query(
      `INSERT INTO vault_event (chain_id, vault, block_number, block_hash, block_timestamp, tx_hash, log_index, event_name, selector, data)
       VALUES (8453, $1, 1, $2, now(), $2, 0, 'Submit', '0x12345678', '0x12345678') RETURNING id`,
      [vault, hash],
    );
    const ch = await db.pool.query(
      `INSERT INTO timelock_change (vault, data, selector, is_timelocked_function, decoded, status, submit_event_id,
                                    submitted_block, submitted_tx, submitted_at, executable_at)
       VALUES ($1, '0x12345678', '0x12345678', true, '{}', 'PENDING', $2, 1, $3, now(), now()) RETURNING id`,
      [vault, ev.rows[0].id, hash],
    );
    for (const path of ["/ok", "/slow"]) {
      const id = randomUUID();
      const secret = generateSecret();
      const enc = encryptSecret(key, id, secret);
      await db.pool.query(
        `INSERT INTO subscription (id, url, start_block, secret_ciphertext, secret_iv, secret_tag)
         VALUES ($1, $2, 0, $3, $4, $5)`,
        [id, `${base}${path}`, enc.ciphertext, enc.iv, enc.tag],
      );
      receivers.state.secrets.set(path, secret);
      // 3 alerts per subscriber (one per event type, the unique key allows no more for one change).
      for (const type of ["change.submitted", "change.executed", "change.revoked"]) {
        await db.pool.query(
          `INSERT INTO delivery (subscription_id, change_id, event_type, block_number, payload, next_attempt_at)
           VALUES ($1, $2, $3, 1, $4, now() - interval '1 second')`,
          [id, ch.rows[0].id, type, JSON.stringify({ type })],
        );
      }
    }
  });

  afterAll(async () => {
    await new Promise<void>((r) => receivers?.server.close(() => r()));
    await db?.drop();
  });

  it("delivers everything to /ok while /slow is still timing out", async () => {
    const worker = new DeliveryWorker(
      db.pool,
      { encryptionKey: key, maxAttempts: 8, timeoutMs: 2000, concurrency: 4, perSubscription: 2, allowPrivate: true, pollIntervalMs: 50 },
      silentLog,
    );
    const stop = new AbortController();
    const running = worker.run(stop.signal);
    const started = Date.now();
    // /slow's requests each take 2s to time out; /ok's 3 deliveries must not wait behind them.
    while ((receivers.state.accepted.get("/ok")?.size ?? 0) < 3 && Date.now() - started < 5000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const okDoneAfterMs = Date.now() - started;
    // At this moment /slow's requests are still hanging: at most 2 may be leased (in flight) at once.
    const leased = await db.pool.query(
      `SELECT count(*)::int AS n FROM delivery d JOIN subscription s ON s.id = d.subscription_id
        WHERE s.url LIKE '%/slow' AND d.status = 'PENDING' AND d.locked_until > now()`,
    );
    stop.abort();
    await running;
    expect(receivers.state.accepted.get("/ok")?.size).toBe(3);
    expect(okDoneAfterMs).toBeLessThan(1500); // well before the first /slow timeout (2s)
    expect(leased.rows[0].n).toBeLessThanOrEqual(2);
  }, 20_000);
});

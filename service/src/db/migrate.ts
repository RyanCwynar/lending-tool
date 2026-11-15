import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import { withTransaction } from "./pool.js";

/**
 * Minimal forward-only migration runner.
 * - Files in /migrations named NNNN_description.sql are applied in lexical order.
 * - Each file runs in its own transaction together with its bookkeeping row, so it's all-or-nothing.
 * - An advisory lock stops two instances (e.g. two containers booting) from migrating at the same time.
 */
const MIGRATION_LOCK_ID = 727_001;

export async function migrate(pool: pg.Pool, dir: string, log: (msg: string) => void = console.log) {
  const lockClient = await pool.connect();
  try {
    await lockClient.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    await lockClient.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        text PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);

    const applied = new Set(
      (await lockClient.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
    );
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(dir, file), "utf8");
      await withTransaction(pool, async (c) => {
        await c.query(sql);
        await c.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      });
      log(`applied migration ${file}`);
    }
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => {});
    lockClient.release();
  }
}

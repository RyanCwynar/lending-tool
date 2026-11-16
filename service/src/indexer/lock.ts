import type pg from "pg";

/** Arbitrary constant shared by all indexer processes; distinct from the migration lock (727_001). */
const INDEXER_LOCK_ID = 727_002;

/**
 * Exactly one indexer may run (docs/PLAN.md "Three roles"). A session-level advisory lock is held on a dedicated
 * connection for the life of the process. If that connection dies, Postgres releases the lock, so `onLost` must stop
 * this indexer before another one can take over.
 *
 * Returns null if another indexer already holds the lock.
 */
export async function acquireIndexerLock(
  pool: pg.Pool,
  onLost: (err: Error) => void,
): Promise<{ release: () => Promise<void> } | null> {
  const client = await pool.connect();
  const { rows } = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [INDEXER_LOCK_ID]);
  if (!rows[0]?.ok) {
    client.release();
    return null;
  }
  client.on("error", onLost);
  return {
    release: async () => {
      client.off("error", onLost);
      await client.query("SELECT pg_advisory_unlock($1)", [INDEXER_LOCK_ID]).catch(() => {});
      client.release();
    },
  };
}

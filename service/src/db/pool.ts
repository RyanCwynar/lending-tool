import pg from "pg";

// Postgres returns int8/numeric as strings by default. That's the safe choice for onchain values
// (uint256 can exceed Number.MAX_SAFE_INTEGER), so we keep it and convert explicitly to bigint where needed.

export function createPool(connectionString: string) {
  return new pg.Pool({ connectionString, max: 10 });
}

/** Run `fn` inside a transaction. Rolls back on any error, so derived state never ends up half-written. */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

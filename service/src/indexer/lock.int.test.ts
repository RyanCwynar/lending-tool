import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acquireIndexerLock } from "./lock.js";
import { TEST_DATABASE_URL, freshDatabase } from "../test/harness.js";

describe.skipIf(!TEST_DATABASE_URL)("indexer singleton lock", () => {
  let db: Awaited<ReturnType<typeof freshDatabase>>;
  beforeAll(async () => {
    db = await freshDatabase();
  });
  afterAll(async () => db?.drop());

  it("lets only one indexer hold the lock, and frees it on release", async () => {
    const first = await acquireIndexerLock(db.pool, () => {});
    expect(first).not.toBeNull();
    expect(await acquireIndexerLock(db.pool, () => {})).toBeNull();
    await first!.release();
    const again = await acquireIndexerLock(db.pool, () => {});
    expect(again).not.toBeNull();
    await again!.release();
  });
});

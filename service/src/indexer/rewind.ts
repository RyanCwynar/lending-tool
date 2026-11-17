/**
 * Undo indexed chain data above a block. Two callers:
 *   - the indexer, when its cursor block is no longer canonical (a reorg deeper than CONFIRMATIONS);
 *   - `rewind-cli`, to rewind the service to a point in time ("forget everything after T").
 * Both go through `undoAbove`, so the two paths can't drift apart.
 *
 * Safe while the indexer is running: we hold the cursor row lock for the whole undo, and the indexer only moves the
 * cursor if it still points where its tick started (see `Indexer.applyRange`), so a tick that overlaps a rewind
 * rolls back instead of skipping the rewound range.
 */
import type pg from "pg";
import type { Config } from "../config.js";
import { withTransaction } from "../db/pool.js";
import type { ChainReader } from "./chain-reader.js";

export interface ForkBlock {
  number: number;
  hash: `0x${string}`;
  timestamp: number;
}

export interface UndoCounts {
  /** Changes resolved (executed/revoked) above the fork, back to PENDING. */
  reopened: number;
  /** Changes submitted above the fork, deleted. */
  changes: number;
  /** Deliveries deleted. */
  deliveries: number;
  /** Raw events deleted. */
  events: number;
}

const hexToBuf = (h: string) => Buffer.from(h.slice(2), "hex");

/**
 * Remove everything learned from blocks above `fork` and move the cursor to it. Runs inside the caller's transaction.
 *
 * includeDelivered: a deliberate rewind deletes every alert above the fork, so replaying the chain sends them again.
 * A reorg keeps the ones already delivered (they can't be recalled, and the unique key stops them being re-sent).
 *
 * Order matters (foreign keys, the status CHECK, and at most one PENDING row per (vault, calldata)):
 *   1. deliveries for events above the fork,
 *   2. changes submitted above the fork (before step 3: a calldata resubmitted after the fork would otherwise
 *      collide with the reopened change in the one-pending index),
 *   3. changes resolved above the fork go back to PENDING (before step 4, which would null their resolve_event_id
 *      while their status still says EXECUTED),
 *   4. raw events above the fork, then the cursor.
 */
export async function undoAbove(
  c: pg.PoolClient,
  stream: string,
  fork: ForkBlock,
  opts: { includeDelivered: boolean; head?: number },
): Promise<UndoCounts> {
  const deliveries = await c.query(
    opts.includeDelivered
      ? "DELETE FROM delivery WHERE block_number > $1"
      : "DELETE FROM delivery WHERE block_number > $1 AND status = 'PENDING'",
    [fork.number],
  );
  // Their remaining deliveries (for the submit itself) go with them via ON DELETE CASCADE.
  const changes = await c.query("DELETE FROM timelock_change WHERE submitted_block > $1", [fork.number]);
  const reopened = await c.query(
    `UPDATE timelock_change SET status = 'PENDING', resolve_event_id = NULL, resolved_block = NULL,
            resolved_tx = NULL, resolved_at = NULL, revoked_by = NULL
      WHERE resolved_block > $1`,
    [fork.number],
  );
  const events = await c.query("DELETE FROM vault_event WHERE block_number > $1", [fork.number]);
  await c.query(
    `UPDATE sync_cursor SET last_block = $2, block_hash = $3, block_timestamp = to_timestamp($4),
            head_block = COALESCE($5, head_block), updated_at = now()
      WHERE stream = $1`,
    [stream, fork.number, hexToBuf(fork.hash), fork.timestamp, opts.head ?? null],
  );
  return {
    reopened: reopened.rowCount ?? 0,
    changes: changes.rowCount ?? 0,
    deliveries: deliveries.rowCount ?? 0,
    events: events.rowCount ?? 0,
  };
}

/** Largest block in [lo, hi] whose timestamp is <= time (unix seconds); `lo` if none is. Binary search over RPC. */
export async function lastBlockAtOrBefore(chain: ChainReader, lo: number, hi: number, time: number): Promise<number> {
  if ((await chain.block(hi)).timestamp <= time) return hi;
  if ((await chain.block(lo)).timestamp > time) return lo;
  // Invariant: ts(lo) <= time < ts(hi).
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await chain.block(mid)).timestamp <= time) lo = mid;
    else hi = mid;
  }
  return lo;
}

export type RewindResult =
  | { kind: "noop"; reason: string; cursorBlock: number | null; cursorTime: string | null }
  | { kind: "rewound"; from: { block: number; time: string }; to: { block: number; time: string }; undone: UndoCounts };

/**
 * Rewind the service to chain time `time`: afterwards the database looks as if the indexer had only ever seen blocks
 * up to the last one at or before `time`. Subscriptions are kept. The indexer then re-indexes forward from there as
 * the chain allows; with the demo's mock-rpc, move its clock back first (or it immediately replays up to its head).
 */
export async function rewindToTime(
  pool: pg.Pool,
  chain: ChainReader,
  config: Pick<Config, "CHAIN_ID" | "VAULTS">,
  time: Date,
): Promise<RewindResult> {
  const stream = `timelocks:${config.CHAIN_ID}`;
  const target = Math.floor(time.getTime() / 1000);
  const cur = await pool.query<{ last_block: string; ts: string | null }>(
    "SELECT last_block, extract(epoch FROM block_timestamp)::bigint AS ts FROM sync_cursor WHERE stream = $1",
    [stream],
  );
  const row = cur.rows[0];
  if (!row) return { kind: "noop", reason: "nothing indexed yet", cursorBlock: null, cursorTime: null };
  const cursorBlock = Number(row.last_block);
  const cursorTs = row.ts === null ? null : Number(row.ts);
  const cursorTime = cursorTs === null ? null : new Date(cursorTs * 1000).toISOString();
  if (cursorTs !== null && cursorTs <= target) {
    return { kind: "noop", reason: "already at or before that time", cursorBlock, cursorTime };
  }

  // Never go below the cursor's starting point (just before the earliest vault), and only ask for blocks the node
  // has: mock-rpc returns nothing above its head, and its head may have been moved back already.
  const floor = Math.min(...config.VAULTS.map((v) => v.startBlock)) - 1;
  const hi = Math.max(floor, Math.min(cursorBlock, Number(await chain.head())));
  const forkNumber = await lastBlockAtOrBefore(chain, floor, hi, target);
  const b = await chain.block(forkNumber);
  const fork: ForkBlock = { number: forkNumber, hash: b.hash, timestamp: b.timestamp };

  return withTransaction(pool, async (c) => {
    // Lock the cursor for the whole undo; the indexer's end-of-tick cursor update waits on it, then sees it moved.
    const locked = await c.query<{ last_block: string }>(
      "SELECT last_block FROM sync_cursor WHERE stream = $1 FOR UPDATE",
      [stream],
    );
    const lockedBlock = Number(locked.rows[0]!.last_block);
    if (lockedBlock <= fork.number) {
      return { kind: "noop", reason: "already at or before that block", cursorBlock: lockedBlock, cursorTime } as const;
    }
    const undone = await undoAbove(c, stream, fork, { includeDelivered: true });
    return {
      kind: "rewound",
      from: { block: lockedBlock, time: cursorTime ?? "" },
      to: { block: fork.number, time: new Date(fork.timestamp * 1000).toISOString() },
      undone,
    } as const;
  });
}

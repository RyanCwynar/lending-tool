/**
 * The indexer: the only writer of chain-derived data (docs/PLAN.md "Three roles").
 *
 * Each tick processes one block range, and everything it learns from that range is committed in ONE transaction:
 * raw events, change status, outbox deliveries and the cursor. A crash anywhere means the range is simply
 * processed again, and unique keys make the second pass a no-op.
 */
import type pg from "pg";
import type { Logger } from "../logger.js";
import type { Config } from "../config.js";
import { withTransaction } from "../db/pool.js";
import { decodeTimelockCall, toJson } from "../chain/decode.js";
import { describeChange, capIdLabel, formatAssetAmount } from "../chain/describe.js";
import { queueDeliveries, type AlertPayload, type AlertType } from "../delivery/outbox.js";
import { applyEvents, changeKey, type ChainEvent } from "./lifecycle.js";
import { ChainReader, isRangeError, type TimelockLog } from "./chain-reader.js";

export interface VaultRow {
  address: `0x${string}`;
  name: string | null;
  asset: string | null;
  asset_symbol: string | null;
  asset_decimals: number | null;
}

interface Cursor {
  lastBlock: number;
  blockHash: `0x${string}`;
}

export type TickResult =
  | { kind: "waiting"; head: number; cursor: number } // nothing confirmed beyond the cursor yet
  | { kind: "indexed"; from: number; to: number; events: number; created: number; resolved: number; deliveries: number }
  | { kind: "reorg"; rewoundTo: number };

const hexToBuf = (h: string) => Buffer.from(h.slice(2), "hex");
const bufToHex = (b: Buffer) => `0x${b.toString("hex")}` as `0x${string}`;
const iso = (unix: number) => new Date(unix * 1000).toISOString();

export class Indexer {
  readonly stream: string;
  private range: number;
  private rangeCeiling: number;
  private vaults = new Map<string, VaultRow>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly chain: ChainReader,
    private readonly config: Config,
    private readonly log: Logger,
  ) {
    this.stream = `timelocks:${config.CHAIN_ID}`;
    this.range = config.LOG_RANGE;
    this.rangeCeiling = config.LOG_RANGE;
  }

  /** Seed configured vaults (name/asset read onchain). Safe to call repeatedly. */
  async init(): Promise<void> {
    if (this.config.VAULTS.length === 0) throw new Error("VAULTS is empty: nothing to index");
    for (const v of this.config.VAULTS) {
      const exists = await this.pool.query("SELECT 1 FROM vault WHERE address = $1", [v.address]);
      if (exists.rowCount) continue;
      const info = await this.chain.vaultInfo(v.address);
      const asset = info.asset ? await this.chain.token(info.asset) : null;
      await this.pool.query(
        `INSERT INTO vault (address, chain_id, name, asset, asset_symbol, asset_decimals, start_block)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (address) DO NOTHING`,
        [v.address, this.config.CHAIN_ID, info.name, info.asset, asset?.symbol ?? null, asset?.decimals ?? null, v.startBlock],
      );
      this.log.info({ vault: v.address, name: info.name }, "vault registered");
    }
    const rows = await this.pool.query<VaultRow>(
      "SELECT address, name, asset, asset_symbol, asset_decimals FROM vault WHERE address = ANY($1)",
      [this.config.VAULTS.map((v) => v.address)],
    );
    this.vaults = new Map(rows.rows.map((r) => [r.address, r]));
  }

  private async loadCursor(): Promise<Cursor | null> {
    const r = await this.pool.query<{ last_block: string; block_hash: Buffer }>(
      "SELECT last_block, block_hash FROM sync_cursor WHERE stream = $1",
      [this.stream],
    );
    const row = r.rows[0];
    return row ? { lastBlock: Number(row.last_block), blockHash: bufToHex(row.block_hash) } : null;
  }

  /** Create the cursor just before the earliest vault's creation block, once that block exists. */
  private async createCursor(head: number): Promise<Cursor | null> {
    const start = Math.min(...this.config.VAULTS.map((v) => v.startBlock)) - 1;
    if (head < start) return null;
    const b = await this.chain.block(start);
    await this.pool.query(
      `INSERT INTO sync_cursor (stream, chain_id, last_block, block_hash, block_timestamp, head_block)
       VALUES ($1, $2, $3, $4, to_timestamp($5), $6) ON CONFLICT (stream) DO NOTHING`,
      [this.stream, this.config.CHAIN_ID, start, hexToBuf(b.hash), b.timestamp, head],
    );
    return this.loadCursor();
  }

  /** One unit of work. Call repeatedly; returns what happened so the loop can decide whether to sleep. */
  async tick(): Promise<TickResult> {
    const head = Number(await this.chain.head());
    const cursor = (await this.loadCursor()) ?? (await this.createCursor(head));
    const safe = head - this.config.CONFIRMATIONS;
    if (!cursor || cursor.lastBlock >= safe) {
      await this.pool.query("UPDATE sync_cursor SET head_block = $2 WHERE stream = $1", [this.stream, head]);
      return { kind: "waiting", head, cursor: cursor?.lastBlock ?? -1 };
    }

    // Reorg check: is the block we last processed still part of the canonical chain?
    const current = await this.chain.block(cursor.lastBlock);
    if (current.hash !== cursor.blockHash) return this.rewind(cursor, head);

    const from = cursor.lastBlock + 1;
    const to = Math.min(safe, from + this.range - 1);
    let logs: TimelockLog[];
    try {
      logs = await this.chain.logs([...this.vaults.keys()] as `0x${string}`[], from, to);
    } catch (err) {
      if (isRangeError(err) && this.range > 1) {
        // A provider's limit doesn't change at runtime: remember it as a ceiling so we don't oscillate.
        this.rangeCeiling = Math.max(1, Math.floor(this.range / 2));
        this.range = this.rangeCeiling;
        this.log.warn({ range: this.range }, "provider rejected log range; halving");
        return { kind: "waiting", head, cursor: cursor.lastBlock };
      }
      throw err;
    }
    // Grow back after a success, but never past a size the provider already rejected.
    this.range = Math.min(this.rangeCeiling, this.range * 2);

    // Timestamps of blocks with events, plus the range end (for the cursor), read before opening the transaction.
    const blockNums = [...new Set(logs.map((l) => l.blockNumber))];
    const [end, ...eventBlocks] = await Promise.all([to, ...blockNums].map((n) => this.chain.block(n)));
    const timestamps = new Map(blockNums.map((n, i) => [n, eventBlocks[i]!.timestamp]));
    // Token labels for cap changes (symbol/decimals), also outside the transaction.
    for (const l of logs) {
      if (l.eventName !== "Submit") continue;
      const id = decodeTimelockCall(l.data).capId;
      if (id?.kind === "collateral") await this.chain.token(id.token);
      if (id?.kind === "market") await Promise.all([this.chain.token(id.collateralToken), this.chain.token(id.loanToken)]);
    }

    const stats = await withTransaction(this.pool, (c) => this.applyRange(c, logs, timestamps, to, end!, head));
    return { kind: "indexed", from, to, events: logs.length, ...stats };
  }

  private async applyRange(
    c: pg.PoolClient,
    logs: TimelockLog[],
    timestamps: Map<number, number>,
    to: number,
    end: { hash: `0x${string}`; timestamp: number },
    head: number,
  ) {
    // 1. Store raw events. ON CONFLICT DO NOTHING + RETURNING: only events we have never seen are applied below.
    const fresh: (ChainEvent & { log: TimelockLog })[] = [];
    for (const l of logs) {
      const r = await c.query<{ id: string }>(
        `INSERT INTO vault_event (chain_id, vault, block_number, block_hash, block_timestamp, tx_hash, log_index,
                                  event_name, selector, data, executable_at, sender)
         VALUES ($1,$2,$3,$4,to_timestamp($5),$6,$7,$8,$9,$10,to_timestamp($11),$12)
         ON CONFLICT (chain_id, tx_hash, log_index) DO NOTHING RETURNING id`,
        [
          this.config.CHAIN_ID, l.vault, l.blockNumber, l.blockHash, timestamps.get(l.blockNumber), l.txHash, l.logIndex,
          l.eventName, l.selector, l.data, l.executableAt === null ? null : Number(l.executableAt), l.sender,
        ],
      );
      const id = r.rows[0]?.id;
      if (id) fresh.push({ eventId: Number(id), vault: l.vault, eventName: l.eventName, data: l.data, blockNumber: l.blockNumber, logIndex: l.logIndex, log: l });
    }

    // 2. Which of these (vault, calldata) keys are already pending in the database?
    const pending = new Map<string, number>();
    if (fresh.length) {
      const r = await c.query<{ id: string; vault: string; data: string }>(
        "SELECT id, vault, data FROM timelock_change WHERE status = 'PENDING' AND vault = ANY($1) AND data = ANY($2)",
        [[...new Set(fresh.map((e) => e.vault))], [...new Set(fresh.map((e) => e.data))]],
      );
      for (const row of r.rows) pending.set(changeKey(row.vault, row.data), Number(row.id));
    }

    // 3. Apply the lifecycle and queue alerts.
    const createdByEvent = new Map<number, number>(); // submit eventId -> change id
    let created = 0, resolved = 0, deliveries = 0;
    for (const op of applyEvents(pending, fresh)) {
      const ev = fresh.find((e) => e.eventId === op.event.eventId)!;
      if (op.op === "anomaly") {
        this.log.warn({ kind: op.kind, vault: ev.vault, tx: ev.log.txHash, data: ev.data.slice(0, 10) }, "lifecycle anomaly; event stored, state unchanged");
        continue;
      }
      if (op.op === "create") {
        const id = await this.insertChange(c, ev.log, ev.eventId, timestamps.get(ev.blockNumber)!);
        createdByEvent.set(ev.eventId, id);
        created++;
        deliveries += await this.queue(c, id, "change.submitted", ev.log, timestamps.get(ev.blockNumber)!);
      } else {
        const changeId = op.changeId === "created-in-batch" ? createdByEvent.get(op.createdBy!.eventId)! : op.changeId;
        await c.query(
          `UPDATE timelock_change
              SET status = $2, resolve_event_id = $3, resolved_block = $4, resolved_tx = $5,
                  resolved_at = to_timestamp($6), revoked_by = $7
            WHERE id = $1 AND status = 'PENDING'`,
          [changeId, op.status, ev.eventId, ev.blockNumber, ev.log.txHash, timestamps.get(ev.blockNumber), ev.log.sender],
        );
        resolved++;
        const type: AlertType = op.status === "EXECUTED" ? "change.executed" : "change.revoked";
        deliveries += await this.queue(c, changeId, type, ev.log, timestamps.get(ev.blockNumber)!);
      }
    }

    // 4. Advance the cursor in the same transaction.
    await c.query(
      `UPDATE sync_cursor SET last_block = $2, block_hash = $3, block_timestamp = to_timestamp($4), head_block = $5,
              updated_at = now() WHERE stream = $1`,
      [this.stream, to, hexToBuf(end.hash), end.timestamp, head],
    );
    return { created, resolved, deliveries };
  }

  private async insertChange(c: pg.PoolClient, l: TimelockLog, eventId: number, ts: number): Promise<number> {
    const d = decodeTimelockCall(l.data);
    const vault = this.vaults.get(l.vault);
    const asset = vault?.asset_decimals != null ? { symbol: vault.asset_symbol, decimals: vault.asset_decimals } : undefined;
    const lookup = (a: string) => this.chain.cachedToken(a);
    const decoded = {
      summary: describeChange(d, lookup, asset),
      capId: d.capId ? toJson(d.capId) : null,
      capLabel: d.capId ? capIdLabel(d.capId, lookup) : null,
      unlimited: d.unlimited,
      targetFunction: d.targetFunction,
      newCapFormatted:
        d.functionName === "increaseAbsoluteCap" && d.args
          ? formatAssetAmount(BigInt(String(d.args.newAbsoluteCap)), asset, d.unlimited)
          : null,
    };
    const r = await c.query<{ id: string }>(
      `INSERT INTO timelock_change (vault, data, selector, function_name, is_timelocked_function, args, decoded, status,
                                    submit_event_id, submitted_block, submitted_tx, submitted_at, executable_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING',$8,$9,$10,to_timestamp($11),to_timestamp($12)) RETURNING id`,
      [
        l.vault, l.data, d.selector, d.functionName, d.isTimelockedFunction, d.args ? JSON.stringify(d.args) : null,
        JSON.stringify(decoded), eventId, l.blockNumber, l.txHash, ts, Number(l.executableAt ?? 0n),
      ],
    );
    return Number(r.rows[0]!.id);
  }

  /** Build the alert from the change's current row and insert one delivery per matching subscription. */
  private async queue(c: pg.PoolClient, changeId: number, type: AlertType, l: TimelockLog, ts: number): Promise<number> {
    const r = await c.query(
      `SELECT ch.*, v.name AS vault_name,
              extract(epoch FROM ch.submitted_at)::bigint AS submitted_unix,
              extract(epoch FROM ch.executable_at)::bigint AS executable_unix,
              extract(epoch FROM ch.resolved_at)::bigint AS resolved_unix
         FROM timelock_change ch JOIN vault v ON v.address = ch.vault WHERE ch.id = $1`,
      [changeId],
    );
    const ch = r.rows[0];
    const payload: AlertPayload = {
      type,
      chainId: this.config.CHAIN_ID,
      vault: { address: ch.vault, name: ch.vault_name },
      change: {
        id: changeId,
        status: ch.status,
        functionName: ch.function_name,
        summary: ch.decoded.summary,
        args: ch.args,
        decoded: ch.decoded,
        isTimelockedFunction: ch.is_timelocked_function,
        submittedAt: iso(Number(ch.submitted_unix)),
        executableAt: iso(Number(ch.executable_unix)),
        submitTx: ch.submitted_tx,
        resolvedAt: ch.resolved_unix ? iso(Number(ch.resolved_unix)) : null,
        resolvedTx: ch.resolved_tx,
        revokedBy: ch.revoked_by,
      },
      event: { name: l.eventName, txHash: l.txHash, blockNumber: l.blockNumber, blockTimestamp: iso(ts) },
    };
    return queueDeliveries(c, payload);
  }

  /**
   * The stored cursor block is no longer canonical: a reorg deeper than CONFIRMATIONS. We don't keep every block
   * hash, so rewind a fixed distance and re-index. Undo order matters (foreign keys and the status CHECK):
   *   1. changes resolved above the fork go back to PENDING,
   *   2. changes submitted above the fork are deleted (their pending deliveries cascade),
   *   3. undelivered alerts for events above the fork are deleted,
   *   4. raw events above the fork are deleted, and the cursor moves back.
   * Alerts already delivered cannot be recalled; that is why we wait for confirmations (documented limitation).
   */
  private async rewind(cursor: Cursor, head: number): Promise<TickResult> {
    const fork = Math.max(
      Math.min(...this.config.VAULTS.map((v) => v.startBlock)) - 1,
      cursor.lastBlock - this.config.REORG_REWIND_BLOCKS,
    );
    const b = await this.chain.block(fork);
    this.log.error({ storedHash: cursor.blockHash, block: cursor.lastBlock, rewindTo: fork }, "reorg detected: cursor block no longer canonical; rewinding");
    await withTransaction(this.pool, async (c) => {
      await c.query(
        `UPDATE timelock_change SET status = 'PENDING', resolve_event_id = NULL, resolved_block = NULL,
                resolved_tx = NULL, resolved_at = NULL, revoked_by = NULL
          WHERE resolved_block > $1`,
        [fork],
      );
      await c.query("DELETE FROM delivery WHERE block_number > $1 AND status = 'PENDING'", [fork]);
      await c.query("DELETE FROM timelock_change WHERE submitted_block > $1", [fork]);
      await c.query("DELETE FROM vault_event WHERE block_number > $1", [fork]);
      await c.query(
        `UPDATE sync_cursor SET last_block = $2, block_hash = $3, block_timestamp = to_timestamp($4), head_block = $5,
                updated_at = now() WHERE stream = $1`,
        [this.stream, fork, hexToBuf(b.hash), b.timestamp, head],
      );
    });
    return { kind: "reorg", rewoundTo: fork };
  }

  /** Run until the signal aborts. Errors are logged and retried with backoff; one bad tick never kills the loop. */
  async run(signal: AbortSignal): Promise<void> {
    let backoff = 1000;
    while (!signal.aborted) {
      try {
        const r = await this.tick();
        backoff = 1000;
        if (r.kind === "indexed" && (r.created || r.resolved)) {
          this.log.info({ from: r.from, to: r.to, created: r.created, resolved: r.resolved, deliveries: r.deliveries }, "indexed");
        }
        if (r.kind === "waiting") await sleep(this.config.POLL_INTERVAL_MS, signal);
      } catch (err) {
        this.log.error({ err, retryInMs: backoff }, "indexer tick failed");
        await sleep(backoff, signal);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { PublicClient } from "viem";
import { timelockedFunctionsAbi } from "../chain/abi.js";
import { encryptSecret, generateSecret } from "./secrets.js";
import { validateWebhookUrl } from "./url-guard.js";

export class SubscriptionInputError extends Error {}

export interface SubscriptionRow {
  id: string;
  url: string;
  vaults: string[] | null;
  functions: string[] | null;
  start_block: string;
  active: boolean;
  created_at: Date;
}

const knownFunctions = new Set<string>(timelockedFunctionsAbi.map((f) => f.name));

/**
 * Create a subscription and return its signing secret. The secret is shown exactly once: only an encrypted copy
 * is stored.
 *
 * start_block: subscribers get events *after* the point they subscribed (no flood of history). That point is the
 * indexer's cursor; if the indexer has not started yet, the current chain head.
 */
export async function createSubscription(
  deps: { pool: pg.Pool; rpc: PublicClient; encryptionKey: Buffer; allowPrivate: boolean; chainId: number },
  input: { url: string; vaults?: string[] | null; functions?: string[] | null },
): Promise<{ subscription: SubscriptionRow; secret: string }> {
  let url: URL;
  try {
    url = await validateWebhookUrl(input.url, deps.allowPrivate);
  } catch (err) {
    throw new SubscriptionInputError(`url rejected: ${(err as Error).message}`);
  }
  const vaults = input.vaults?.length ? input.vaults.map((v) => v.toLowerCase()) : null;
  for (const v of vaults ?? []) {
    if (!/^0x[0-9a-f]{40}$/.test(v)) throw new SubscriptionInputError(`not an address: ${v}`);
  }
  const functions = input.functions?.length ? input.functions : null;
  for (const f of functions ?? []) {
    if (!knownFunctions.has(f)) {
      throw new SubscriptionInputError(`unknown timelocked function "${f}"; expected one of ${[...knownFunctions].join(", ")}`);
    }
  }

  const cursor = await deps.pool.query<{ last_block: string }>(
    "SELECT last_block FROM sync_cursor WHERE stream = $1",
    [`timelocks:${deps.chainId}`],
  );
  const startBlock = cursor.rows[0] ? BigInt(cursor.rows[0].last_block) : await deps.rpc.getBlockNumber({ cacheTime: 0 });

  const id = randomUUID();
  const secret = generateSecret();
  const enc = encryptSecret(deps.encryptionKey, id, secret);
  const r = await deps.pool.query<SubscriptionRow>(
    `INSERT INTO subscription (id, url, vaults, functions, start_block, secret_ciphertext, secret_iv, secret_tag)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, url, vaults, functions, start_block, active, created_at`,
    [id, url.toString(), vaults, functions, startBlock.toString(), enc.ciphertext, enc.iv, enc.tag],
  );
  return { subscription: r.rows[0]!, secret };
}

export async function deactivateSubscription(pool: pg.Pool, id: string): Promise<SubscriptionRow | null> {
  const r = await pool.query<SubscriptionRow>(
    `UPDATE subscription SET active = false WHERE id = $1
     RETURNING id, url, vaults, functions, start_block, active, created_at`,
    [id],
  );
  return r.rows[0] ?? null;
}

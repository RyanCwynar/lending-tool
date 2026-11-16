import { createSchema } from "graphql-yoga";
import { GraphQLError } from "graphql";
import type pg from "pg";
import type { PublicClient } from "viem";
import type { Config } from "../config.js";
import { BigIntScalar, JSONScalar } from "./scalars.js";
import {
  createSubscription,
  deactivateSubscription,
  SubscriptionInputError,
  type SubscriptionRow,
} from "../delivery/subscriptions.js";

export interface GraphQLContext {
  pool: pg.Pool;
  rpc: PublicClient;
  config: Config;
  /** Present when SECRET_ENCRYPTION_KEY is configured; createSubscription needs it. */
  encryptionKey: Buffer | null;
}

/**
 * The API is the visibility layer over what the indexer and the delivery worker have done, plus subscription
 * management (the only thing it writes). Chain data is never written here.
 *
 * Time: "executable" and "stale" use chain time (the timestamp of the last indexed block), not the wall clock,
 * which is how the contract itself judges a timelock (block.timestamp).
 */
const typeDefs = /* GraphQL */ `
  scalar BigInt
  scalar JSON

  type Query {
    health: Health!
    vaults: [Vault!]!
    vault(address: String!): Vault
    """
    Timelocked changes, newest first.
    pendingAt: changes that were pending at that moment (ISO time), e.g. "what was pending on 2026-11-11?".
    stale: pending changes past executableAt by more than STALE_AFTER_DAYS (chain time); often junk that can never execute.
    """
    timelockChanges(
      vault: String
      status: ChangeStatus
      functionName: String
      stale: Boolean
      executableBefore: String
      pendingAt: String
      limit: Int = 100
    ): [TimelockChange!]!
    timelockChange(id: ID!): TimelockChange
    subscriptions: [Subscription!]!
    deliveries(subscriptionId: ID, status: DeliveryStatus, limit: Int = 100): [Delivery!]!
  }

  type Mutation {
    "Subscribe a webhook. The returned secret is shown only once; use it to verify X-Signature."
    createSubscription(input: CreateSubscriptionInput!): CreatedSubscription!
    deactivateSubscription(id: ID!): Subscription!
  }

  input CreateSubscriptionInput {
    url: String!
    "Only these vault addresses (default: all watched vaults)."
    vaults: [String!]
    "Only these timelocked functions, e.g. increaseAbsoluteCap, addAdapter (default: all)."
    functions: [String!]
  }

  type CreatedSubscription {
    subscription: Subscription!
    secret: String!
  }

  enum ChangeStatus { PENDING EXECUTED REVOKED }
  enum DeliveryStatus { PENDING DELIVERED FAILED }

  type Health {
    ok: Boolean!
    database: ComponentStatus!
    rpc: RpcStatus!
    indexer: IndexerStatus
  }
  type ComponentStatus { ok: Boolean! error: String }
  type RpcStatus {
    ok: Boolean!
    error: String
    expectedChainId: Int!
    chainId: Int
    blockNumber: BigInt
  }
  type IndexerStatus {
    lastBlock: BigInt!
    headBlock: BigInt
    "headBlock - lastBlock at the indexer's last poll (includes the confirmation depth)."
    lagBlocks: BigInt
    "Timestamp of the last indexed block: the service's notion of now."
    chainTime: String
    updatedAt: String!
  }

  type Vault {
    address: String!
    name: String
    asset: String
    assetSymbol: String
    startBlock: BigInt!
    pendingCount: Int!
    changes(status: ChangeStatus, limit: Int = 100): [TimelockChange!]!
  }

  type TimelockChange {
    id: ID!
    vault: Vault!
    functionName: String
    "Readable one-liner, e.g. Increase absolute cap on collateral cbBTC to 500,000,000 USDC."
    summary: String!
    "False for calldata that can never be executed (not a timelocked function)."
    isTimelockedFunction: Boolean!
    args: JSON
    decoded: JSON!
    status: ChangeStatus!
    submittedAt: String!
    submittedBlock: BigInt!
    submitTx: String!
    executableAt: String!
    "Pending and past executableAt (chain time): anyone can execute it now."
    executable: Boolean!
    stale: Boolean!
    resolvedAt: String
    resolvedBlock: BigInt
    resolvedTx: String
    revokedBy: String
    deliveries: [Delivery!]!
  }

  type Subscription {
    id: ID!
    url: String!
    vaults: [String!]
    functions: [String!]
    startBlock: BigInt!
    active: Boolean!
    createdAt: String!
    deliveryCounts: DeliveryCounts!
  }
  type DeliveryCounts { pending: Int! delivered: Int! failed: Int! }

  type Delivery {
    id: ID!
    subscriptionId: ID!
    changeId: ID!
    eventType: String!
    status: DeliveryStatus!
    attempts: Int!
    nextAttemptAt: String!
    lastStatusCode: Int
    lastError: String
    deliveredAt: String
    createdAt: String!
    payload: JSON!
  }
`;

const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);

async function checkDatabase(pool: pg.Pool) {
  try {
    await pool.query("SELECT 1");
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

async function checkRpc(rpc: PublicClient, expectedChainId: number) {
  try {
    const [chainId, blockNumber] = await Promise.all([rpc.getChainId(), rpc.getBlockNumber({ cacheTime: 0 })]);
    const mismatch = chainId !== expectedChainId;
    return {
      ok: !mismatch,
      error: mismatch ? `RPC is on chain ${chainId}, expected ${expectedChainId}` : null,
      expectedChainId,
      chainId,
      blockNumber,
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message, expectedChainId, chainId: null, blockNumber: null };
  }
}

/** Columns for TimelockChange, with executable/stale computed against chain time in SQL. */
const changeSelect = `
  WITH chain AS (SELECT block_timestamp AS now FROM sync_cursor WHERE stream = $1)
  SELECT c.*,
         c.status = 'PENDING' AND (SELECT now FROM chain) >= c.executable_at AS executable,
         c.status = 'PENDING' AND c.executable_at < (SELECT now FROM chain) - make_interval(days => $2) AS stale
    FROM timelock_change c`;

function badInput(message: string): never {
  throw new GraphQLError(message, { extensions: { code: "BAD_USER_INPUT" } });
}

function parseTime(value: string, field: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) badInput(`${field} must be an ISO date-time`);
  return d;
}

export const schema = createSchema<GraphQLContext>({
  typeDefs,
  resolvers: {
    BigInt: BigIntScalar,
    JSON: JSONScalar,

    Query: {
      health: async (_root, _args, ctx) => {
        // A failing dependency is reported, not thrown, so the health query stays useful while degraded.
        const [database, rpc] = await Promise.all([checkDatabase(ctx.pool), checkRpc(ctx.rpc, ctx.config.CHAIN_ID)]);
        const cur = database.ok
          ? (await ctx.pool.query("SELECT * FROM sync_cursor WHERE stream = $1", [`timelocks:${ctx.config.CHAIN_ID}`])).rows[0]
          : undefined;
        const indexer = cur && {
          lastBlock: cur.last_block,
          headBlock: cur.head_block,
          lagBlocks: cur.head_block === null ? null : (BigInt(cur.head_block) - BigInt(cur.last_block)).toString(),
          chainTime: isoOrNull(cur.block_timestamp),
          updatedAt: cur.updated_at.toISOString(),
        };
        return { ok: database.ok && rpc.ok, database, rpc, indexer: indexer ?? null };
      },

      vaults: async (_r, _a, ctx) => (await ctx.pool.query("SELECT * FROM vault ORDER BY name")).rows,
      vault: async (_r, { address }: { address: string }, ctx) =>
        (await ctx.pool.query("SELECT * FROM vault WHERE address = $1", [address.toLowerCase()])).rows[0] ?? null,

      timelockChanges: async (_r, args: Record<string, unknown>, ctx) => {
        const where: string[] = [];
        const params: unknown[] = [`timelocks:${ctx.config.CHAIN_ID}`, ctx.config.STALE_AFTER_DAYS];
        const add = (sql: string, value: unknown) => {
          params.push(value);
          where.push(sql.replace("?", `$${params.length}`));
        };
        if (args.vault) add("c.vault = ?", String(args.vault).toLowerCase());
        if (args.status) add("c.status = ?", args.status);
        if (args.functionName) add("c.function_name = ?", args.functionName);
        if (args.executableBefore) add("c.executable_at < ?", parseTime(String(args.executableBefore), "executableBefore"));
        if (args.pendingAt) {
          const t = parseTime(String(args.pendingAt), "pendingAt");
          add("c.submitted_at <= ?", t);
          add("(c.resolved_at IS NULL OR c.resolved_at > ?)", t);
        }
        const limit = Math.min(Math.max(Number(args.limit ?? 100), 1), 1000);
        let sql = `${changeSelect} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
        if (args.stale !== undefined && args.stale !== null) sql = `SELECT * FROM (${sql}) x WHERE x.stale = ${args.stale ? "true" : "false"}`;
        sql += ` ORDER BY submitted_block DESC, id DESC LIMIT ${limit}`;
        return (await ctx.pool.query(sql, params)).rows;
      },

      timelockChange: async (_r, { id }: { id: string }, ctx) =>
        (await ctx.pool.query(`${changeSelect} WHERE c.id = $3`, [`timelocks:${ctx.config.CHAIN_ID}`, ctx.config.STALE_AFTER_DAYS, id])).rows[0] ?? null,

      subscriptions: async (_r, _a, ctx) => (await ctx.pool.query("SELECT * FROM subscription ORDER BY created_at")).rows,

      deliveries: async (_r, args: { subscriptionId?: string; status?: string; limit?: number }, ctx) => {
        const limit = Math.min(Math.max(Number(args.limit ?? 100), 1), 1000);
        const r = await ctx.pool.query(
          `SELECT * FROM delivery
            WHERE ($1::uuid IS NULL OR subscription_id = $1) AND ($2::text IS NULL OR status = $2)
            ORDER BY created_at DESC, id LIMIT $3`,
          [args.subscriptionId ?? null, args.status ?? null, limit],
        );
        return r.rows;
      },
    },

    Mutation: {
      createSubscription: async (_r, { input }: { input: { url: string; vaults?: string[]; functions?: string[] } }, ctx) => {
        if (!ctx.encryptionKey) throw new GraphQLError("SECRET_ENCRYPTION_KEY is not configured on this API");
        try {
          return await createSubscription(
            {
              pool: ctx.pool,
              rpc: ctx.rpc,
              encryptionKey: ctx.encryptionKey,
              allowPrivate: ctx.config.WEBHOOK_ALLOW_PRIVATE,
              chainId: ctx.config.CHAIN_ID,
            },
            input,
          );
        } catch (err) {
          if (err instanceof SubscriptionInputError) badInput(err.message);
          throw err;
        }
      },
      deactivateSubscription: async (_r, { id }: { id: string }, ctx) =>
        (await deactivateSubscription(ctx.pool, id)) ?? badInput(`no subscription ${id}`),
    },

    Vault: {
      assetSymbol: (v) => v.asset_symbol,
      startBlock: (v) => v.start_block,
      pendingCount: async (v, _a, ctx) =>
        (await ctx.pool.query("SELECT count(*)::int AS n FROM timelock_change WHERE vault = $1 AND status = 'PENDING'", [v.address])).rows[0].n,
      changes: async (v, args: { status?: string; limit?: number }, ctx) =>
        (
          await ctx.pool.query(
            `${changeSelect} WHERE c.vault = $3 AND ($4::text IS NULL OR c.status = $4) ORDER BY c.submitted_block DESC, c.id DESC LIMIT $5`,
            [`timelocks:${ctx.config.CHAIN_ID}`, ctx.config.STALE_AFTER_DAYS, v.address, args.status ?? null, Math.min(args.limit ?? 100, 1000)],
          )
        ).rows,
    },

    TimelockChange: {
      vault: async (c, _a, ctx) => (await ctx.pool.query("SELECT * FROM vault WHERE address = $1", [c.vault])).rows[0],
      functionName: (c) => c.function_name,
      summary: (c) => c.decoded.summary,
      isTimelockedFunction: (c) => c.is_timelocked_function,
      submittedAt: (c) => c.submitted_at.toISOString(),
      submittedBlock: (c) => c.submitted_block,
      submitTx: (c) => c.submitted_tx,
      executableAt: (c) => c.executable_at.toISOString(),
      executable: (c) => c.executable ?? false,
      stale: (c) => c.stale ?? false,
      resolvedAt: (c) => isoOrNull(c.resolved_at),
      resolvedBlock: (c) => c.resolved_block,
      resolvedTx: (c) => c.resolved_tx,
      revokedBy: (c) => c.revoked_by,
      deliveries: async (c, _a, ctx) =>
        (await ctx.pool.query("SELECT * FROM delivery WHERE change_id = $1 ORDER BY created_at", [c.id])).rows,
    },

    Subscription: {
      startBlock: (s: SubscriptionRow) => s.start_block,
      createdAt: (s: SubscriptionRow) => s.created_at.toISOString(),
      deliveryCounts: async (s: SubscriptionRow, _a, ctx) => {
        const r = await ctx.pool.query(
          `SELECT count(*) FILTER (WHERE status = 'PENDING')::int AS pending,
                  count(*) FILTER (WHERE status = 'DELIVERED')::int AS delivered,
                  count(*) FILTER (WHERE status = 'FAILED')::int AS failed
             FROM delivery WHERE subscription_id = $1`,
          [s.id],
        );
        return r.rows[0];
      },
    },

    Delivery: {
      subscriptionId: (d) => d.subscription_id,
      changeId: (d) => d.change_id,
      eventType: (d) => d.event_type,
      nextAttemptAt: (d) => d.next_attempt_at.toISOString(),
      lastStatusCode: (d) => d.last_status_code,
      lastError: (d) => d.last_error,
      deliveredAt: (d) => isoOrNull(d.delivered_at),
      createdAt: (d) => d.created_at.toISOString(),
    },
  },
});

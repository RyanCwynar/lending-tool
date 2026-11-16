/**
 * Entry point. One codebase, three roles (docs/PLAN.md "Three roles"):
 *   ROLE=indexer  exactly one; reads the chain, writes events/changes/outbox (advisory lock enforces singleton)
 *   ROLE=worker   any number; delivers queued webhooks
 *   ROLE=api      any number; GraphQL visibility + subscription management
 *   ROLE=all      everything in one process (local dev)
 * They share nothing but Postgres.
 */
import { createServer, type Server } from "node:http";
import { createYoga } from "graphql-yoga";
import { loadConfig, requireEncryptionKey } from "./config.js";
import { createLogger } from "./logger.js";
import { createPool } from "./db/pool.js";
import { createRpcClient } from "./rpc/client.js";
import { schema, type GraphQLContext } from "./graphql/schema.js";
import { ChainReader } from "./indexer/chain-reader.js";
import { Indexer } from "./indexer/indexer.js";
import { acquireIndexerLock } from "./indexer/lock.js";
import { DeliveryWorker } from "./delivery/worker.js";

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL).child({ role: config.ROLE });
const pool = createPool(config.DATABASE_URL);
const rpc = createRpcClient(config.RPC_URL);
const roles = config.ROLE === "all" ? (["indexer", "worker", "api"] as const) : ([config.ROLE] as const);
const stop = new AbortController();
const running: Promise<unknown>[] = [];
let server: Server | null = null;
let releaseLock: (() => Promise<void>) | null = null;

// Without this handler, an idle client error (e.g. Postgres restarting) would crash the process.
pool.on("error", (err) => log.error({ err }, "idle postgres client error"));

async function startIndexer() {
  const chainId = await rpc.getChainId();
  if (chainId !== config.CHAIN_ID) throw new Error(`RPC is on chain ${chainId}, expected ${config.CHAIN_ID}`);
  const lock = await acquireIndexerLock(pool, (err) => {
    // Postgres released the lock with the connection; another indexer may now take over, so this one must stop.
    log.fatal({ err }, "lost indexer lock connection; exiting");
    process.exit(1);
  });
  if (!lock) throw new Error("another indexer is already running (advisory lock held)");
  releaseLock = lock.release;
  const indexer = new Indexer(pool, new ChainReader(rpc), config, log.child({ component: "indexer" }));
  await indexer.init();
  log.info({ vaults: config.VAULTS.length, confirmations: config.CONFIRMATIONS }, "indexer started");
  running.push(indexer.run(stop.signal));
}

function startWorker() {
  const worker = new DeliveryWorker(
    pool,
    {
      encryptionKey: requireEncryptionKey(config),
      maxAttempts: config.DELIVERY_MAX_ATTEMPTS,
      timeoutMs: config.DELIVERY_TIMEOUT_MS,
      concurrency: config.WORKER_CONCURRENCY,
      allowPrivate: config.WEBHOOK_ALLOW_PRIVATE,
      retryScale: config.RETRY_SCHEDULE_SCALE,
      perSubscription: config.WORKER_PER_SUBSCRIPTION,
      pollIntervalMs: Math.min(1000, config.POLL_INTERVAL_MS),
    },
    log.child({ component: "worker" }),
  );
  log.info({ concurrency: config.WORKER_CONCURRENCY }, "delivery worker started");
  running.push(worker.run(stop.signal));
}

function startApi() {
  const context: GraphQLContext = {
    pool,
    rpc,
    config,
    encryptionKey: config.SECRET_ENCRYPTION_KEY ? requireEncryptionKey(config) : null,
  };
  const yoga = createYoga({ schema, context: () => context, graphiql: true });
  server = createServer(yoga);
  server.listen(config.PORT, () => log.info(`GraphQL API listening on http://localhost:${config.PORT}${yoga.graphqlEndpoint}`));
}

let shuttingDown = false;
async function shutdown(signal: string, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "shutting down");
  stop.abort();
  server?.close();
  await Promise.allSettled(running);
  await releaseLock?.().catch(() => {});
  await pool.end().catch((err) => log.error({ err }, "error closing pool"));
  process.exit(code);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  for (const role of roles) {
    if (role === "indexer") await startIndexer();
    if (role === "worker") startWorker();
    if (role === "api") startApi();
  }
} catch (err) {
  log.fatal({ err }, "startup failed");
  await shutdown("startup-failure", 1);
}

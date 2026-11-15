import { createServer } from "node:http";
import { createYoga } from "graphql-yoga";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createPool } from "./db/pool.js";
import { createRpcClient } from "./rpc/client.js";
import { schema, type GraphQLContext } from "./graphql/schema.js";

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL);
const pool = createPool(config.DATABASE_URL);
const rpc = createRpcClient(config.RPC_URL);

// Without this handler, an idle client error (e.g. Postgres restarting) would crash the process.
pool.on("error", (err) => log.error({ err }, "idle postgres client error"));

const context: GraphQLContext = { pool, rpc, config };
const yoga = createYoga({
  schema,
  context: () => context,
  graphiql: true,
});

const server = createServer(yoga);
server.listen(config.PORT, () => {
  log.info(`GraphQL API listening on http://localhost:${config.PORT}${yoga.graphqlEndpoint}`);
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "shutting down");
  server.close();
  await pool.end().catch((err) => log.error({ err }, "error closing pool"));
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

/**
 * Rewind the service to a point in chain time: forget every event, change and alert after it, and let the indexer
 * re-index forward from there. Subscriptions are kept. See rewind.ts.
 *
 *   node dist/indexer/rewind-cli.js 2026-11-01T00:00:00Z        (in a container: docker compose exec indexer …)
 *   pnpm rewind 2026-11-01T00:00:00Z                             (dev)
 *
 * Uses the same env as the service (DATABASE_URL, RPC_URL, CHAIN_ID, VAULTS). Safe while the indexer runs.
 * Demo: move mock-rpc's clock back first, otherwise the indexer immediately replays up to the old head:
 *   curl -XPOST 'localhost:8545/control/advance-to?time=2026-11-01T00:00:00Z'
 */
import { loadConfig } from "../config.js";
import { createPool } from "../db/pool.js";
import { createRpcClient } from "../rpc/client.js";
import { ChainReader } from "./chain-reader.js";
import { rewindToTime } from "./rewind.js";

const arg = process.argv[2];
const time = arg ? new Date(arg) : null;
if (!time || Number.isNaN(time.getTime())) {
  console.error("usage: rewind-cli <ISO time>   e.g. rewind-cli 2026-11-01T00:00:00Z");
  process.exit(2);
}

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
try {
  const r = await rewindToTime(pool, new ChainReader(createRpcClient(config.RPC_URL)), config, time);
  if (r.kind === "noop") {
    console.log(`nothing to rewind: ${r.reason} (cursor at block ${r.cursorBlock ?? "-"}, ${r.cursorTime ?? "-"})`);
  } else {
    const u = r.undone;
    console.log(`rewound block ${r.from.block} (${r.from.time}) -> ${r.to.block} (${r.to.time})`);
    console.log(`  deleted ${u.events} events, ${u.changes} changes, ${u.deliveries} deliveries; reopened ${u.reopened} changes as PENDING`);
  }
} finally {
  await pool.end();
}

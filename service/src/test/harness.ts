/**
 * Shared setup for integration tests: a fresh Postgres database (migrated) and an in-process mock-rpc.
 * Needs TEST_DATABASE_URL pointing at a Postgres server where the user may CREATE DATABASE;
 * tests using it are skipped otherwise.
 */
import path from "node:path";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { pino } from "pino";
import { migrate } from "../db/migrate.js";
import { loadConfig, type Config } from "../config.js";
import { ChainModel } from "../harness/chain-model.js";
import { loadFixture, type Fixture } from "../harness/fixture.js";
import { createMockRpcServer, MockChain } from "../harness/mock-rpc.js";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

export async function freshDatabase(): Promise<{ pool: pg.Pool; url: string; drop: () => Promise<void> }> {
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  const name = `watcher_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(TEST_DATABASE_URL!);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 5 });
  // DROP DATABASE ... WITH (FORCE) terminates idle connections; that's expected at teardown.
  pool.on("error", () => {});
  await migrate(pool, path.resolve("migrations"), () => {});
  return {
    pool,
    url: url.toString(),
    drop: async () => {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

export async function startMockRpc(wallNow?: () => number) {
  const fixture: Fixture = await loadFixture("fixtures/base-timelocks.json");
  const chain = new MockChain(new ChainModel(fixture), wallNow);
  const server = createMockRpcServer(chain);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { fixture, chain, url, close: () => new Promise<void>((r) => server.close(() => r())) };
}

export function testConfig(overrides: Record<string, string>): Config {
  return loadConfig({
    DATABASE_URL: "postgres://unused@localhost/unused",
    RPC_URL: "http://127.0.0.1:1",
    CHAIN_ID: "8453",
    LOG_LEVEL: "warn",
    ...overrides,
  });
}

export const silentLog = pino({ level: "silent" });

/** VAULTS env value for the fixture's demo vaults. */
export const vaultsEnv = (f: Fixture) => f.vaults.map((v) => `${v.address}:${v.startBlock}`).join(",");

import { createSchema } from "graphql-yoga";
import type pg from "pg";
import type { PublicClient } from "viem";
import type { Config } from "../config.js";
import { BigIntScalar } from "./scalars.js";

export interface GraphQLContext {
  pool: pg.Pool;
  rpc: PublicClient;
  config: Config;
}

const typeDefs = /* GraphQL */ `
  scalar BigInt

  type Query {
    health: Health!
  }

  type Health {
    ok: Boolean!
    database: ComponentStatus!
    rpc: RpcStatus!
  }

  type ComponentStatus {
    ok: Boolean!
    error: String
  }

  type RpcStatus {
    ok: Boolean!
    error: String
    expectedChainId: Int!
    chainId: Int
    blockNumber: BigInt
  }
`;

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
    const [chainId, blockNumber] = await Promise.all([rpc.getChainId(), rpc.getBlockNumber()]);
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

export const schema = createSchema<GraphQLContext>({
  typeDefs,
  resolvers: {
    BigInt: BigIntScalar,
    Query: {
      health: async (_root, _args, ctx) => {
        // A failing dependency is reported, not thrown, so the health query stays useful while degraded.
        const [database, rpc] = await Promise.all([
          checkDatabase(ctx.pool),
          checkRpc(ctx.rpc, ctx.config.CHAIN_ID),
        ]);
        return { ok: database.ok && rpc.ok, database, rpc };
      },
    },
  },
});

import { createPublicClient, http, type PublicClient } from "viem";

export function createRpcClient(rpcUrl: string): PublicClient {
  return createPublicClient({
    // viem caches eth_blockNumber for ~4s by default. The indexer polls the head itself, and in replay a chain
    // day can pass per wall second, so a stale head would only add lag.
    cacheTime: 0,
    transport: http(rpcUrl, {
      retryCount: 3, // viem retries with exponential backoff on network errors and 429 / 5xx
      timeout: 15_000,
      batch: true, // JSON-RPC batching cuts round trips when many calls go out in the same tick
    }),
  });
}

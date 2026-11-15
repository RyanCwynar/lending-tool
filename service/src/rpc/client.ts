import { createPublicClient, http, type PublicClient } from "viem";

export function createRpcClient(rpcUrl: string): PublicClient {
  return createPublicClient({
    transport: http(rpcUrl, {
      retryCount: 3, // viem retries with exponential backoff on network errors and 429 / 5xx
      timeout: 15_000,
      batch: true, // JSON-RPC batching cuts round trips when many calls go out in the same tick
    }),
  });
}

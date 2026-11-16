import { readFile } from "node:fs/promises";

/**
 * A recorded slice of Base mainnet: only the "material" blocks (those containing our events),
 * kept in raw JSON-RPC form so mock-rpc can serve them byte-for-byte like a real node would.
 */
export interface Fixture {
  chainId: number;
  capturedAt: string;
  fromBlock: number;
  toBlock: number;
  vaults: { address: `0x${string}`; name: string; startBlock: number }[];
  /**
   * Real headers, sorted by number: every block containing a log, the range endpoints, and an anchor every
   * 500k blocks. Other blocks' timestamps are interpolated between neighbours (Base's block time has changed).
   */
  blocks: RpcBlockHeader[];
  logs: RpcLog[];
  /** Recorded eth_call results, keyed by target + calldata. */
  calls: { to: string; data: string; result: string }[];
}

/** Raw JSON-RPC block header fields we keep (hex quantities, as nodes return them). */
export interface RpcBlockHeader {
  number: string;
  hash: string;
  parentHash: string;
  timestamp: string;
}

/** Raw JSON-RPC log, exactly as eth_getLogs returns it. */
export interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  transactionIndex: string;
  logIndex: string;
  removed: boolean;
}

export async function loadFixture(path: string): Promise<Fixture> {
  return JSON.parse(await readFile(path, "utf8")) as Fixture;
}

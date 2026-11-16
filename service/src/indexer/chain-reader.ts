import type { PublicClient } from "viem";
import { erc20ReadAbi, timelockEventsAbi, vaultReadAbi } from "../chain/abi.js";
import type { TokenInfo } from "../chain/describe.js";

/** A decoded Submit / Accept / Revoke log, with what the indexer needs from it. */
export interface TimelockLog {
  vault: `0x${string}`;
  eventName: "Submit" | "Accept" | "Revoke";
  selector: `0x${string}`;
  data: `0x${string}`;
  executableAt: bigint | null;
  sender: `0x${string}` | null;
  blockNumber: number;
  blockHash: `0x${string}`;
  txHash: `0x${string}`;
  logIndex: number;
}

/** Errors that mean "ask for a smaller block range" (wording differs per provider). */
export function isRangeError(err: unknown): boolean {
  const e = err as { message?: string; details?: string; shortMessage?: string };
  const text = `${e.details ?? ""} ${e.shortMessage ?? ""} ${e.message ?? ""}`.toLowerCase();
  return /block range|max block|range (is )?too|ranges over|exceed|too many|response size|limit exceeded|query returned more than/.test(text);
}

/** Everything the indexer reads from the chain goes through here. */
export class ChainReader {
  private readonly tokens = new Map<string, TokenInfo>();

  constructor(private readonly rpc: PublicClient) {}

  head(): Promise<bigint> {
    return this.rpc.getBlockNumber({ cacheTime: 0 });
  }

  async block(n: number): Promise<{ hash: `0x${string}`; timestamp: number }> {
    const b = await this.rpc.getBlock({ blockNumber: BigInt(n) });
    return { hash: b.hash, timestamp: Number(b.timestamp) };
  }

  async logs(vaults: readonly `0x${string}`[], from: number, to: number): Promise<TimelockLog[]> {
    const raw = await this.rpc.getLogs({
      address: [...vaults],
      events: timelockEventsAbi,
      fromBlock: BigInt(from),
      toBlock: BigInt(to),
      strict: true,
    });
    return raw.map((l) => {
      const args = l.args as { selector: `0x${string}`; data: `0x${string}`; executableAt?: bigint; sender?: `0x${string}` };
      return {
        vault: l.address.toLowerCase() as `0x${string}`,
        eventName: l.eventName,
        selector: args.selector.toLowerCase() as `0x${string}`,
        data: args.data.toLowerCase() as `0x${string}`,
        executableAt: args.executableAt ?? null,
        sender: (args.sender?.toLowerCase() as `0x${string}` | undefined) ?? null,
        blockNumber: Number(l.blockNumber),
        blockHash: l.blockHash.toLowerCase() as `0x${string}`,
        txHash: l.transactionHash.toLowerCase() as `0x${string}`,
        logIndex: l.logIndex,
      };
    });
  }

  async vaultInfo(vault: `0x${string}`): Promise<{ name: string | null; asset: `0x${string}` | null }> {
    const [name, asset] = await Promise.all([
      this.rpc.readContract({ address: vault, abi: vaultReadAbi, functionName: "name" }).catch(() => null),
      this.rpc.readContract({ address: vault, abi: vaultReadAbi, functionName: "asset" }).catch(() => null),
    ]);
    return { name, asset: (asset?.toLowerCase() as `0x${string}` | undefined) ?? null };
  }

  /** symbol()/decimals(), cached for the process lifetime. Failures give nulls: labels fall back to addresses. */
  async token(address: string): Promise<TokenInfo> {
    const key = address.toLowerCase();
    const cached = this.tokens.get(key);
    if (cached) return cached;
    const addr = key as `0x${string}`;
    const [symbol, decimals] = await Promise.all([
      this.rpc.readContract({ address: addr, abi: erc20ReadAbi, functionName: "symbol" }).catch(() => null),
      this.rpc.readContract({ address: addr, abi: erc20ReadAbi, functionName: "decimals" }).catch(() => null),
    ]);
    const info = { symbol, decimals };
    this.tokens.set(key, info);
    return info;
  }

  cachedToken(address: string): TokenInfo | undefined {
    return this.tokens.get(address.toLowerCase());
  }
}

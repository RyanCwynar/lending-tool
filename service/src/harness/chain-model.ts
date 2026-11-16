import { keccak256, toHex } from "viem";
import type { Fixture, RpcBlockHeader, RpcLog } from "./fixture.js";

/**
 * Pure model of the recorded chain: block ↔ timestamp mapping, block headers, and log filtering.
 * Real headers come from the fixture; every other block is synthesized deterministically.
 */
export class ChainModel {
  readonly fromBlock: number;
  readonly toBlock: number;
  readonly chainId: number;
  private readonly headers: { n: number; ts: number; raw: RpcBlockHeader }[];
  private readonly byNumber = new Map<number, RpcBlockHeader>();
  private readonly logs: (RpcLog & { _n: number })[];
  private readonly calls = new Map<string, string>();

  constructor(fixture: Fixture) {
    this.fromBlock = fixture.fromBlock;
    this.toBlock = fixture.toBlock;
    this.chainId = fixture.chainId;
    this.headers = fixture.blocks
      .map((raw) => ({ n: Number(BigInt(raw.number)), ts: Number(BigInt(raw.timestamp)), raw }))
      .sort((a, b) => a.n - b.n);
    for (const h of this.headers) this.byNumber.set(h.n, h.raw);
    this.logs = fixture.logs.map((l) => ({ ...l, _n: Number(BigInt(l.blockNumber)) }));
    for (const c of fixture.calls) this.calls.set(`${c.to.toLowerCase()}|${c.data.toLowerCase()}`, c.result);
  }

  /**
   * Timestamp of any block. Real headers are exact; between two real headers we interpolate linearly
   * (Base's block time changed over this range, so no single formula fits). Outside the recorded range
   * we extrapolate at 2s/block, which only matters for blocks before the first vault existed.
   */
  timestampOf(n: number): number {
    const exact = this.byNumber.get(n);
    if (exact) return Number(BigInt(exact.timestamp));
    const hs = this.headers;
    const first = hs[0]!;
    const last = hs[hs.length - 1]!;
    if (n < first.n) return first.ts - (first.n - n) * 2;
    if (n > last.n) return last.ts + (n - last.n) * 2;
    const i = this.upperIndex(n); // hs[i-1].n < n < hs[i].n
    const a = hs[i - 1]!;
    const b = hs[i]!;
    return a.ts + Math.floor(((n - a.n) * (b.ts - a.ts)) / (b.n - a.n));
  }

  /** Highest block whose timestamp is <= t (inverse of timestampOf). */
  blockAtTime(t: number): number {
    let lo = this.fromBlock - 1_000_000;
    let hi = this.toBlock + 1_000_000;
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      if (this.timestampOf(mid) <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Real hash for recorded blocks, deterministic synthetic hash otherwise (stable across runs). */
  hashOf(n: number): string {
    return this.byNumber.get(n)?.hash ?? keccak256(toHex(`mock-rpc block ${n}`));
  }

  /** A block header in JSON-RPC form, with the fields viem's block formatter reads. */
  header(n: number) {
    const real = this.byNumber.get(n);
    return {
      number: toHex(n),
      hash: this.hashOf(n),
      parentHash: real?.parentHash ?? this.hashOf(n - 1),
      timestamp: toHex(this.timestampOf(n)),
      nonce: "0x0000000000000000",
      sha3Uncles: "0x" + "0".repeat(64),
      logsBloom: "0x" + "0".repeat(512),
      transactionsRoot: "0x" + "0".repeat(64),
      stateRoot: "0x" + "0".repeat(64),
      receiptsRoot: "0x" + "0".repeat(64),
      miner: "0x" + "0".repeat(40),
      difficulty: "0x0",
      totalDifficulty: "0x0",
      extraData: "0x",
      size: "0x0",
      gasLimit: "0x0",
      gasUsed: "0x0",
      baseFeePerGas: "0x0",
      mixHash: "0x" + "0".repeat(64),
      transactions: [],
      uncles: [],
    };
  }

  /** eth_getLogs semantics over the recorded logs: inclusive block range, address and topic filters. */
  getLogs(filter: { from: number; to: number; addresses: string[] | null; topics: (string | string[] | null)[] }): RpcLog[] {
    const addrs = filter.addresses?.map((a) => a.toLowerCase()) ?? null;
    return this.logs
      .filter((l) => l._n >= filter.from && l._n <= filter.to)
      .filter((l) => !addrs || addrs.includes(l.address.toLowerCase()))
      .filter((l) =>
        filter.topics.every((want, i) => {
          if (want === null || want === undefined) return true;
          const have = l.topics[i]?.toLowerCase();
          return Array.isArray(want) ? want.some((w) => w.toLowerCase() === have) : want.toLowerCase() === have;
        }),
      )
      .map(({ _n, ...log }) => log);
  }

  call(to: string, data: string): string | undefined {
    return this.calls.get(`${to.toLowerCase()}|${data.toLowerCase()}`);
  }

  private upperIndex(n: number): number {
    let lo = 0;
    let hi = this.headers.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.headers[mid]!.n > n) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }
}

/** Parse "1d/2s", "1w/2s", "6h/1s" or a plain multiplier "3600" into chain-seconds per wall-second. */
export function parseSpeed(spec: string): number {
  const unit: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
  const parse = (part: string) => {
    const m = /^(\d+(?:\.\d+)?)([smhdw])$/.exec(part.trim());
    if (!m) throw new Error(`bad duration "${part}"`);
    return Number(m[1]) * unit[m[2]!]!;
  };
  if (/^\d+(\.\d+)?$/.test(spec)) return Number(spec);
  const [chain, wall] = spec.split("/");
  if (!chain || !wall) throw new Error(`bad speed "${spec}" (use e.g. 1d/2s)`);
  return parse(chain) / parse(wall);
}

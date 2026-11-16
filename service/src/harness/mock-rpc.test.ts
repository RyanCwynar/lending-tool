import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createPublicClient, http, parseAbiItem } from "viem";
import { ChainModel, parseSpeed } from "./chain-model.js";
import { loadFixture, type Fixture } from "./fixture.js";
import { createMockRpcServer, MockChain } from "./mock-rpc.js";

let fixture: Fixture;
let model: ChainModel;
let wall = 1_000_000; // controllable wall clock for the mock
let chain: MockChain;
let server: ReturnType<typeof createMockRpcServer>;
let url: string;

beforeAll(async () => {
  fixture = await loadFixture("fixtures/base-timelocks.json");
  model = new ChainModel(fixture);
  chain = new MockChain(model, () => wall);
  server = createMockRpcServer(chain);
  await new Promise<void>((r) => server.listen(0, r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("ChainModel", () => {
  it("returns real timestamps for recorded headers and monotonic interpolation between them", () => {
    for (const b of fixture.blocks) expect(model.timestampOf(Number(BigInt(b.number)))).toBe(Number(BigInt(b.timestamp)));
    let prev = -Infinity;
    for (let n = fixture.fromBlock; n <= fixture.toBlock; n += 9_973) {
      const ts = model.timestampOf(n);
      expect(ts).toBeGreaterThanOrEqual(prev);
      prev = ts;
    }
  });

  it("blockAtTime inverts timestampOf for recorded blocks", () => {
    for (const b of fixture.blocks.slice(0, 50)) {
      const n = Number(BigInt(b.number));
      expect(model.timestampOf(model.blockAtTime(Number(BigInt(b.timestamp))))).toBe(Number(BigInt(b.timestamp)));
      expect(model.blockAtTime(Number(BigInt(b.timestamp)))).toBeGreaterThanOrEqual(n);
    }
  });

  it("parses speeds", () => {
    expect(parseSpeed("1d/2s")).toBe(43_200);
    expect(parseSpeed("1w/2s")).toBe(302_400);
    expect(parseSpeed("60")).toBe(60);
    expect(() => parseSpeed("fast")).toThrow();
  });
});

describe("mock-rpc over HTTP via viem", () => {
  // cacheTime: 0 because viem caches eth_blockNumber for ~4s by default, which hides head movement.
  const client = () => createPublicClient({ cacheTime: 0, transport: http(url, { batch: true, retryCount: 0 }) });

  it("serves exactly the recorded logs once the head reaches the end (same as Alchemy returned)", async () => {
    chain.reset();
    chain.advanceTo({ block: fixture.toBlock });
    const c = client();
    expect(await c.getChainId()).toBe(8453);
    expect(Number(await c.getBlockNumber())).toBe(fixture.toBlock);
    const logs = await c.getLogs({
      address: fixture.vaults.map((v) => v.address),
      fromBlock: BigInt(fixture.fromBlock),
      toBlock: BigInt(fixture.toBlock),
    });
    expect(logs).toHaveLength(fixture.logs.length);
    expect(logs[0]!.transactionHash).toBe(fixture.logs[0]!.transactionHash);
    expect(logs.at(-1)!.transactionHash).toBe(fixture.logs.at(-1)!.transactionHash);
  });

  it("filters by event topic like a node", async () => {
    const submits = await client().getLogs({
      address: fixture.vaults.map((v) => v.address),
      event: parseAbiItem("event Submit(bytes4 indexed selector, bytes data, uint256 executableAt)"),
      fromBlock: BigInt(fixture.fromBlock),
      toBlock: BigInt(fixture.toBlock),
    });
    expect(submits.length).toBe(333); // research §3: 333 changes across the 4 demo vaults
  });

  it("never returns logs above the head, and play advances chain time", async () => {
    chain.reset();
    const firstLogBlock = Number(BigInt(fixture.logs[0]!.blockNumber));
    const c = client();
    expect(await c.getLogs({ fromBlock: BigInt(fixture.fromBlock), toBlock: BigInt(fixture.toBlock) })).toHaveLength(0);

    chain.advanceTo({ block: firstLogBlock - 1 });
    chain.play(parseSpeed("1d/1s"));
    expect(Number(await c.getBlockNumber())).toBe(firstLogBlock - 1);
    wall += 1; // one wall second = one chain day
    expect(Number(await c.getBlockNumber())).toBeGreaterThan(firstLogBlock);
    const logs = await c.getLogs({ fromBlock: BigInt(fixture.fromBlock), toBlock: BigInt(fixture.toBlock) });
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((l) => Number(l.blockNumber) <= Number(chain.head()))).toBe(true);

    chain.pause();
    const pausedHead = chain.head();
    wall += 100;
    expect(chain.head()).toBe(pausedHead);
  });

  it("returns real headers for recorded blocks and stable synthetic ones otherwise", async () => {
    chain.reset();
    chain.advanceTo({ block: fixture.toBlock });
    const recorded = fixture.blocks[5]!;
    const b = await client().getBlock({ blockNumber: BigInt(recorded.number) });
    expect(b.hash).toBe(recorded.hash);
    const synthetic1 = await client().getBlock({ blockNumber: BigInt(recorded.number) + 1n });
    const synthetic2 = await client().getBlock({ blockNumber: BigInt(recorded.number) + 1n });
    expect(synthetic1.hash).toBe(synthetic2.hash);
    expect(await client().getBlock({ blockNumber: BigInt(fixture.toBlock + 10) }).catch(() => null)).toBeNull();
  });

  it("answers recorded eth_calls and errors on unknown ones", async () => {
    chain.advanceTo({ block: fixture.toBlock });
    const v = fixture.vaults[0]!;
    const name = await client().readContract({
      address: v.address,
      abi: [parseAbiItem("function name() view returns (string)")],
      functionName: "name",
    });
    expect(name).toBe(v.name);
    await expect(
      client().readContract({ address: v.address, abi: [parseAbiItem("function totalAssets() view returns (uint256)")], functionName: "totalAssets" }),
    ).rejects.toThrow();
  });

  it("injects range-limit faults", async () => {
    chain.advanceTo({ block: fixture.toBlock });
    chain.faults = { rate429: 0, rangeLimit: 1000, timeoutRate: 0 };
    await expect(client().getLogs({ fromBlock: BigInt(fixture.fromBlock), toBlock: BigInt(fixture.fromBlock + 5000) })).rejects.toThrow(/max block range/);
    chain.faults = { rate429: 0, rangeLimit: null, timeoutRate: 0 };
  });
});

/**
 * Capture the replay fixture from a real Base node (run once; the output is committed).
 *
 *   RPC_URL=https://base-mainnet.g.alchemy.com/v2/<key> pnpm capture-fixture
 *
 * Records, for the demo vaults:
 *   - every Submit / Accept / Revoke log between the vaults' start blocks and TO_BLOCK
 *   - the header (number, hash, parentHash, timestamp) of each block containing such a log
 *   - the eth_call results the service needs for labels (vault name/asset, token symbol/decimals)
 */
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  createPublicClient,
  decodeEventLog,
  encodeEventTopics,
  encodeFunctionData,
  http,
  type Hex,
} from "viem";
import { erc20ReadAbi, timelockEventsAbi, vaultReadAbi } from "../chain/abi.js";
import { decodeTimelockCall } from "../chain/decode.js";
import type { Fixture, RpcBlockHeader, RpcLog } from "./fixture.js";

// Demo vaults (docs/PLAN.md "Demo vaults"); start block = vault creation block.
const VAULTS = [
  { address: "0xbeeff2490FEffa212faC2f6553682C219E6a8845", startBlock: 45_427_904 }, // Steakhouse High Yield USDC Edition
  { address: "0x1deEfABEe758AAbdC29a542B24ca3b75aFD56765", startBlock: 37_179_468 }, // Gauntlet USDC Frontier
  { address: "0x050cE30b927Da55177A4914EC73480238BAD56f0", startBlock: 37_179_342 }, // Gauntlet USDC Prime
  { address: "0x189A1a23F46321a196646314E6a078a404513C8F", startBlock: 50_183_714 }, // Splits Earn USDC
] as const;
// Same head as docs/research/timelock-history.md, so the expected counts there apply to the fixture.
const TO_BLOCK = 58_258_937;
const OUT = path.resolve(process.argv[2] ?? "fixtures/base-timelocks.json");

const rpcUrl = process.env.RPC_URL;
if (!rpcUrl) throw new Error("RPC_URL is required (a provider that serves historical eth_getLogs)");
const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 5, timeout: 30_000 }) });

const topic0s = timelockEventsAbi.map((e) => encodeEventTopics({ abi: [e] })[0]!);
const addresses = VAULTS.map((v) => v.address.toLowerCase());

async function getLogsChunked(from: number, to: number): Promise<RpcLog[]> {
  const out: RpcLog[] = [];
  let range = 100_000;
  for (let start = from; start <= to; ) {
    const end = Math.min(start + range - 1, to);
    try {
      const logs = (await client.request({
        method: "eth_getLogs",
        params: [{ address: addresses as Hex[], topics: [topic0s], fromBlock: `0x${start.toString(16)}`, toBlock: `0x${end.toString(16)}` }],
      })) as unknown as RpcLog[];
      out.push(...logs);
      start = end + 1;
    } catch (err) {
      if (range <= 1_000) throw err;
      range = Math.floor(range / 2);
      console.error(`range rejected, retrying with ${range}: ${(err as Error).message.slice(0, 100)}`);
    }
  }
  return out;
}

async function main() {
  const fromBlock = Math.min(...VAULTS.map((v) => v.startBlock));
  console.error(`fetching logs ${fromBlock} → ${TO_BLOCK}`);
  const logs = await getLogsChunked(fromBlock, TO_BLOCK);
  logs.sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.logIndex) - BigInt(b.logIndex)));
  console.error(`${logs.length} logs`);

  // Headers of material blocks, the range endpoints, and an anchor every 500k blocks. Base's block time has
  // changed over its history (2s at first, faster later), so mock-rpc interpolates timestamps between real
  // neighbouring headers instead of assuming a fixed block time.
  const anchors: number[] = [];
  for (let n = fromBlock; n < TO_BLOCK; n += 500_000) anchors.push(n);
  const blockNumbers = [
    ...new Set([fromBlock, TO_BLOCK, ...anchors, ...logs.map((l) => Number(BigInt(l.blockNumber)))]),
  ].sort((a, b) => a - b);
  const blocks: RpcBlockHeader[] = [];
  for (let i = 0; i < blockNumbers.length; i += 50) {
    const batch = await Promise.all(
      blockNumbers.slice(i, i + 50).map((n) =>
        client.request({ method: "eth_getBlockByNumber", params: [`0x${n.toString(16)}`, false] }),
      ),
    );
    for (const b of batch) {
      if (!b) throw new Error("missing block");
      blocks.push({ number: b.number!, hash: b.hash!, parentHash: b.parentHash, timestamp: b.timestamp });
    }
  }

  // Timestamps must be non-decreasing in block order, or interpolation in mock-rpc would be meaningless.
  for (let i = 1; i < blocks.length; i++) {
    if (BigInt(blocks[i]!.timestamp) < BigInt(blocks[i - 1]!.timestamp)) {
      throw new Error(`timestamps go backwards at block ${Number(BigInt(blocks[i]!.number))}`);
    }
  }

  // eth_call results needed for labels: vault name/asset, token symbol/decimals for assets and cap collateral.
  const calls: Fixture["calls"] = [];
  const record = async (to: string, data: Hex) => {
    const key = `${to.toLowerCase()}|${data}`;
    if (calls.some((c) => `${c.to}|${c.data}` === key)) return;
    const result = await client.request({ method: "eth_call", params: [{ to: to as Hex, data }, "latest"] });
    calls.push({ to: to.toLowerCase(), data, result });
  };
  const tokens = new Set<string>();
  const vaults: Fixture["vaults"] = [];
  for (const v of VAULTS) {
    const name = await client.readContract({ address: v.address, abi: vaultReadAbi, functionName: "name" });
    const asset = await client.readContract({ address: v.address, abi: vaultReadAbi, functionName: "asset" });
    await record(v.address, encodeFunctionData({ abi: vaultReadAbi, functionName: "name" }));
    await record(v.address, encodeFunctionData({ abi: vaultReadAbi, functionName: "asset" }));
    tokens.add(asset.toLowerCase());
    vaults.push({ address: v.address, name, startBlock: v.startBlock });
  }
  for (const log of logs) {
    const ev = decodeEventLog({ abi: timelockEventsAbi, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] });
    if (ev.eventName !== "Submit") continue;
    const id = decodeTimelockCall(ev.args.data).capId;
    if (id?.kind === "collateral") tokens.add(id.token.toLowerCase());
    if (id?.kind === "market") tokens.add(id.collateralToken.toLowerCase()).add(id.loanToken.toLowerCase());
  }
  for (const t of tokens) {
    for (const fn of ["symbol", "decimals"] as const) {
      try {
        await record(t, encodeFunctionData({ abi: erc20ReadAbi, functionName: fn }));
      } catch (err) {
        console.error(`skip ${fn}() on ${t}: ${(err as Error).message.slice(0, 80)}`);
      }
    }
  }

  const fixture: Fixture = {
    chainId: await client.getChainId(),
    capturedAt: new Date().toISOString(),
    fromBlock,
    toBlock: TO_BLOCK,
    vaults,
    blocks,
    logs,
    calls,
  };
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(fixture, null, 1) + "\n");
  console.error(`wrote ${OUT}: ${blocks.length} blocks, ${logs.length} logs, ${calls.length} calls, ${tokens.size} tokens`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

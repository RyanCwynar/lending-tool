/**
 * mock-rpc: a JSON-RPC server that replays the recorded fixture as if it were a live Base node.
 * The service points RPC_URL here and cannot tell the difference; nothing in service code knows about replay.
 *
 * Time is faked by controlling the chain head: "now" for the service is the head block's timestamp.
 *   virtual_now = anchor_ts + (wall_now - anchor_wall) * speed      (speed = 0 while paused)
 *   head        = highest block with timestamp <= virtual_now          (capped at the fixture's last block)
 * Logs above the head are never returned, so the indexer can't see the future.
 *
 * Control (HTTP, not JSON-RPC):
 *   POST /control/reset                      head back to just before the first vault existed, paused
 *   POST /control/play?speed=1w/2s           advance chain time continuously
 *   POST /control/pause
 *   POST /control/advance-to?block=N | ?time=2026-11-12T15:00:00Z
 *   POST /control/faults?rate429=0.2&rangeLimit=5000&timeoutRate=0.05   (all optional; no params = clear)
 *   GET  /control/state
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { toHex } from "viem";
import { ChainModel, parseSpeed } from "./chain-model.js";
import { loadFixture } from "./fixture.js";

interface Faults {
  rate429: number;
  rangeLimit: number | null;
  timeoutRate: number;
}

export class MockChain {
  private anchorTs = 0;
  private anchorWall = 0;
  private speed = 0; // chain seconds per wall second; 0 = paused
  faults: Faults = { rate429: 0, rangeLimit: null, timeoutRate: 0 };

  constructor(
    readonly model: ChainModel,
    private readonly wallNow: () => number = () => Date.now() / 1000,
  ) {
    this.reset();
  }

  reset() {
    this.anchorTs = this.model.timestampOf(this.model.fromBlock - 1);
    this.anchorWall = this.wallNow();
    this.speed = 0;
    this.faults = { rate429: 0, rangeLimit: null, timeoutRate: 0 };
  }

  virtualNow(): number {
    return this.anchorTs + (this.wallNow() - this.anchorWall) * this.speed;
  }

  head(): number {
    return Math.min(this.model.toBlock, this.model.blockAtTime(Math.floor(this.virtualNow())));
  }

  play(speed: number) {
    this.anchorTs = this.virtualNow();
    this.anchorWall = this.wallNow();
    this.speed = speed;
  }

  pause() {
    this.play(0);
  }

  /** Jump to a block or a time; keeps playing at the current speed if it was playing. */
  advanceTo(target: { block?: number; time?: number }) {
    const ts = target.block !== undefined ? this.model.timestampOf(target.block) : target.time!;
    this.anchorTs = ts;
    this.anchorWall = this.wallNow();
  }

  state() {
    const head = this.head();
    return {
      head,
      headTimestamp: new Date(this.model.timestampOf(head) * 1000).toISOString(),
      virtualNow: new Date(this.virtualNow() * 1000).toISOString(),
      playing: this.speed > 0,
      speed: this.speed,
      fromBlock: this.model.fromBlock,
      toBlock: this.model.toBlock,
      done: head >= this.model.toBlock,
      faults: this.faults,
    };
  }

  /** Resolve a block tag or hex number, as a node would. */
  private resolveBlock(tag: unknown): number {
    if (tag === undefined || tag === null || tag === "latest" || tag === "safe" || tag === "finalized" || tag === "pending") {
      return this.head();
    }
    if (tag === "earliest") return 0;
    if (typeof tag === "string" && tag.startsWith("0x")) return Number(BigInt(tag));
    throw new RpcError(-32602, `invalid block tag ${String(tag)}`);
  }

  /** Handle one JSON-RPC call. Throws RpcError for JSON-RPC level errors. */
  handle(method: string, params: unknown[]): unknown {
    switch (method) {
      case "eth_chainId":
        return toHex(this.model.chainId);
      case "net_version":
        return String(this.model.chainId);
      case "eth_blockNumber":
        return toHex(this.head());
      case "eth_getBlockByNumber": {
        const n = this.resolveBlock(params[0]);
        return n > this.head() ? null : this.model.header(n);
      }
      case "eth_getLogs": {
        const f = (params[0] ?? {}) as {
          address?: string | string[];
          topics?: (string | string[] | null)[];
          fromBlock?: string;
          toBlock?: string;
          blockHash?: string;
        };
        if (f.blockHash) throw new RpcError(-32602, "mock-rpc: blockHash filters are not supported");
        const head = this.head();
        const from = this.resolveBlock(f.fromBlock ?? "latest");
        const to = this.resolveBlock(f.toBlock ?? "latest");
        if (from > to) throw new RpcError(-32602, "invalid block range: fromBlock > toBlock");
        if (this.faults.rangeLimit !== null && to - from + 1 > this.faults.rangeLimit) {
          throw new RpcError(-32005, `query exceeds max block range ${this.faults.rangeLimit}`);
        }
        const addresses = f.address === undefined ? null : Array.isArray(f.address) ? f.address : [f.address];
        return this.model.getLogs({ from, to: Math.min(to, head), addresses, topics: f.topics ?? [] });
      }
      case "eth_call": {
        const [call] = params as [{ to?: string; data?: string; input?: string }];
        const result = this.model.call(call?.to ?? "", call?.data ?? call?.input ?? "");
        if (result === undefined) throw new RpcError(-32000, "mock-rpc: no recorded result for this call");
        return result;
      }
      default:
        throw new RpcError(-32601, `mock-rpc: method ${method} not supported`);
    }
  }
}

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

type JsonRpcRequest = { jsonrpc?: string; id?: unknown; method: string; params?: unknown[] };

function respondOne(chain: MockChain, req: JsonRpcRequest) {
  try {
    return { jsonrpc: "2.0", id: req.id ?? null, result: chain.handle(req.method, req.params ?? []) };
  } catch (err) {
    const code = err instanceof RpcError ? err.code : -32603;
    return { jsonrpc: "2.0", id: req.id ?? null, error: { code, message: (err as Error).message } };
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function createMockRpcServer(chain: MockChain, log: (msg: string) => void = () => {}) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://mock");
    try {
      if (url.pathname.startsWith("/control/")) {
        const q = url.searchParams;
        switch (url.pathname) {
          case "/control/state":
            break;
          case "/control/reset":
            chain.reset();
            log("reset");
            break;
          case "/control/play":
            chain.play(parseSpeed(q.get("speed") ?? "1d/2s"));
            log(`play speed=${q.get("speed") ?? "1d/2s"}`);
            break;
          case "/control/pause":
            chain.pause();
            break;
          case "/control/advance-to": {
            const block = q.get("block");
            const time = q.get("time");
            if (block) chain.advanceTo({ block: Number(block) });
            else if (time) chain.advanceTo({ time: Math.floor(Date.parse(time) / 1000) });
            else return send(res, 400, { error: "pass block= or time=" });
            break;
          }
          case "/control/faults":
            chain.faults = {
              rate429: Number(q.get("rate429") ?? 0),
              rangeLimit: q.get("rangeLimit") ? Number(q.get("rangeLimit")) : null,
              timeoutRate: Number(q.get("timeoutRate") ?? 0),
            };
            log(`faults ${JSON.stringify(chain.faults)}`);
            break;
          default:
            return send(res, 404, { error: "unknown control endpoint" });
        }
        return send(res, 200, chain.state());
      }

      if (req.method !== "POST") return send(res, 405, { error: "JSON-RPC needs POST" });
      // Injected transport faults, the failures seen on real public endpoints.
      if (Math.random() < chain.faults.rate429) return send(res, 429, { error: "mock-rpc: request limit reached" });
      if (Math.random() < chain.faults.timeoutRate) {
        await new Promise((r) => setTimeout(r, 60_000));
        return send(res, 504, { error: "mock-rpc: timeout" });
      }

      const parsed = JSON.parse(await readBody(req)) as JsonRpcRequest | JsonRpcRequest[];
      const body = Array.isArray(parsed) ? parsed.map((r) => respondOne(chain, r)) : respondOne(chain, parsed);
      return send(res, 200, body);
    } catch (err) {
      return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: (err as Error).message } });
    }
  });
}

// Entry point: `node dist/harness/mock-rpc.js` (or `pnpm mock-rpc`).
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.MOCK_RPC_PORT ?? 8545);
  const fixturePath = process.env.FIXTURE_PATH ?? "fixtures/base-timelocks.json";
  const chain = new MockChain(new ChainModel(await loadFixture(fixturePath)));
  createMockRpcServer(chain, (m) => console.log(`[mock-rpc] ${m}`)).listen(port, () => {
    const s = chain.state();
    console.log(`[mock-rpc] listening on :${port}, blocks ${s.fromBlock}..${s.toBlock}, head ${s.head} (paused)`);
  });
}

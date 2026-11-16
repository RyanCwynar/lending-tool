/**
 * mock-receivers: stand-ins for integrators' webhook endpoints, each with a different behaviour.
 *
 *   POST /ok     always 200
 *   POST /flaky  500 for the first 2 attempts of each delivery, then 200      → proves retries
 *   POST /down   always 500                                                 → proves FAILED after max attempts
 *   POST /slow   answers after SLOW_MS (longer than the worker's timeout)   → proves timeouts don't block others
 *
 * Every endpoint verifies X-Signature with the secret registered for it (401 if wrong, like a real integrator
 * should) and records what arrived, including duplicate delivery ids (at-least-once delivery means duplicates
 * are possible; receivers dedupe on X-Delivery-Id).
 *
 * Control:
 *   POST /control/register   {"path": "/ok", "secret": "whsec_..."}
 *   POST /control/reset      forget everything
 *   GET  /received           per-endpoint summary;  GET /received?path=/ok&full=1 for every request
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { DELIVERY_ID_HEADER, SIGNATURE_HEADER, verify } from "../delivery/signing.js";

export const ENDPOINTS = ["/ok", "/flaky", "/down", "/slow"] as const;
type Endpoint = (typeof ENDPOINTS)[number];

interface Received {
  deliveryId: string;
  type: string | null;
  summary: string | null;
  txHash: string | null;
  signature: "ok" | "malformed" | "stale" | "mismatch" | "no-secret";
  status: number;
  duplicate: boolean;
  at: string;
}

export class ReceiverState {
  secrets = new Map<string, string>();
  received = new Map<string, Received[]>();
  attempts = new Map<string, number>(); // `${path}|${deliveryId}` -> attempts seen
  accepted = new Map<string, Set<string>>(); // path -> delivery ids answered 2xx

  reset() {
    this.secrets.clear();
    this.received.clear();
    this.attempts.clear();
    this.accepted.clear();
  }

  summary() {
    return Object.fromEntries(
      ENDPOINTS.map((p) => {
        const list = this.received.get(p) ?? [];
        const byType: Record<string, number> = {};
        for (const r of list) if (r.status === 200 && !r.duplicate) byType[r.type ?? "?"] = (byType[r.type ?? "?"] ?? 0) + 1;
        return [
          p,
          {
            requests: list.length,
            accepted: this.accepted.get(p)?.size ?? 0,
            duplicatesAfterAccept: list.filter((r) => r.duplicate).length,
            badSignatures: list.filter((r) => r.signature !== "ok").length,
            acceptedByType: byType,
          },
        ];
      }),
    );
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

export function createMockReceivers(
  state = new ReceiverState(),
  opts: { slowMs?: number; now?: () => number; log?: (m: string) => void } = {},
) {
  const slowMs = opts.slowMs ?? 10_000;
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const log = opts.log ?? (() => {});

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://mock");
    const body = await readBody(req);

    if (url.pathname === "/control/register" && req.method === "POST") {
      const { path, secret } = JSON.parse(body) as { path: string; secret: string };
      state.secrets.set(path, secret);
      return send(res, 200, { registered: path });
    }
    if (url.pathname === "/control/reset" && req.method === "POST") {
      state.reset();
      return send(res, 200, { reset: true });
    }
    if (url.pathname === "/received" && req.method === "GET") {
      const path = url.searchParams.get("path");
      if (path && url.searchParams.get("full")) return send(res, 200, state.received.get(path) ?? []);
      return send(res, 200, state.summary());
    }

    const path = url.pathname as Endpoint;
    if (!ENDPOINTS.includes(path) || req.method !== "POST") return send(res, 404, { error: "unknown endpoint" });

    const deliveryId = String(req.headers[DELIVERY_ID_HEADER] ?? "");
    // Secrets are registered per full URL path (incl. query), so two subscriptions can share an endpoint
    // (e.g. /ok?sub=a and /ok?sub=b) with different secrets.
    const secret = state.secrets.get(`${url.pathname}${url.search}`) ?? state.secrets.get(path);
    const sig = secret ? verify(secret, req.headers[SIGNATURE_HEADER] as string | undefined, body, now()) : null;
    const signature: Received["signature"] = sig === null ? "no-secret" : sig.ok ? "ok" : sig.reason;
    let parsed: { type?: string; change?: { summary?: string }; event?: { txHash?: string } } = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      /* recorded as unparsed */
    }

    const key = `${path}|${deliveryId}`;
    const attempt = (state.attempts.get(key) ?? 0) + 1;
    state.attempts.set(key, attempt);

    let status: number;
    if (signature !== "ok") status = 401;
    else if (path === "/down") status = 500;
    else if (path === "/flaky" && attempt <= 2) status = 500;
    else status = 200;

    if (path === "/slow") await new Promise((r) => setTimeout(r, slowMs));

    const acceptedSet = state.accepted.get(path) ?? new Set<string>();
    state.accepted.set(path, acceptedSet);
    const duplicate = status === 200 && acceptedSet.has(deliveryId);
    if (status === 200) acceptedSet.add(deliveryId);

    const list = state.received.get(path) ?? [];
    list.push({
      deliveryId,
      type: parsed.type ?? null,
      summary: parsed.change?.summary ?? null,
      txHash: parsed.event?.txHash ?? null,
      signature,
      status,
      duplicate,
      at: new Date().toISOString(),
    });
    state.received.set(path, list);
    log(`${path} ${status} ${parsed.type ?? "?"} ${parsed.change?.summary ?? ""}${duplicate ? " (duplicate)" : ""}`);
    if (!res.destroyed) send(res, status, { ok: status === 200 });
  });
  return { server, state };
}

// Entry point: `node dist/harness/mock-receivers.js` (or `pnpm mock-receivers`).
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.MOCK_RECEIVERS_PORT ?? 9000);
  const { server } = createMockReceivers(undefined, {
    slowMs: Number(process.env.SLOW_MS ?? 10_000),
    log: (m) => console.log(`[receivers] ${m}`),
  });
  server.listen(port, () => console.log(`[receivers] listening on :${port} (${ENDPOINTS.join(" ")})`));
}

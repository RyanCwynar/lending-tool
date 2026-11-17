/**
 * Replay demo + integration check. Drives a running stack (docker compose up) from the outside:
 *
 *   1. reset: mock-rpc head back to the start (paused), receivers forget everything, database emptied
 *   2. subscribe four webhook endpoints through the GraphQL API and register their secrets with the receivers
 *   3. play the recorded Base history (Oct 2025 → Nov 2026) at SPEED, printing curator changes as the service sees them
 *   4. wait for deliveries to settle, print what each receiver got, and check the numbers (exit 1 on any failure)
 *
 * Usage (from the repo root):   docker compose run --rm replay
 *    or (from service/):        pnpm replay       (with API_URL, MOCK_RPC_URL, RECEIVERS_URL, DATABASE_URL set)
 * Env: SPEED (default 2w/1s), SETTLE_TIMEOUT_S (default 300), TIMELINE=all|notable|none (default notable)
 */
import pg from "pg";

const API_URL = process.env.API_URL ?? "http://localhost:4000/graphql";
const MOCK_RPC_URL = process.env.MOCK_RPC_URL ?? "http://localhost:8545";
const RECEIVERS_URL = process.env.RECEIVERS_URL ?? "http://localhost:9000";
/** How the *service* reaches the receivers (inside docker compose that's the service name, not localhost). */
const RECEIVERS_URL_FOR_SERVICE = process.env.RECEIVERS_URL_FOR_SERVICE ?? RECEIVERS_URL;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://morpho:morpho@localhost:5432/morpho";
const SPEED = process.env.SPEED ?? "2w/1s";
const SETTLE_TIMEOUT_S = Number(process.env.SETTLE_TIMEOUT_S ?? 300);
const TIMELINE = process.env.TIMELINE ?? "notable";

// docs/research/timelock-history.md §3, for the 4 demo vaults at block 58,258,937.
const EXPECTED_STATUS = { PENDING: 18, EXECUTED: 307, REVOKED: 8 };
const ALL_ALERTS = 648; // 333 submitted + 315 executed/revoked
const SLOW_ALERTS = 58; // Splits Earn USDC: 29 submitted + 29 executed

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const c = { dim: "\x1b[2m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m", bold: "\x1b[1m", reset: "\x1b[0m" };

async function gql<T = any>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(`GraphQL: ${json.errors.map((e) => e.message).join("; ")}`);
  return json.data!;
}

async function control(base: string, path: string, method = "POST", body?: unknown) {
  const res = await fetch(`${base}${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!res.ok) throw new Error(`${base}${path}: HTTP ${res.status}`);
  return res.json() as Promise<any>;
}

async function waitFor<T>(what: string, fn: () => Promise<T | false>, timeoutS = 60): Promise<T> {
  const deadline = Date.now() + timeoutS * 1000;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v !== false) return v;
    } catch (err) {
      lastErr = err;
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}${lastErr ? `: ${(lastErr as Error).message}` : ""}`);
}

const short = (s: string) => `${s.slice(0, 10)}…`;
const day = (iso: string) => iso.slice(0, 16).replace("T", " ");

async function main() {
  console.log(`${c.bold}Vault V2 Timelock Notifier: replay of recorded Base history${c.reset}`);

  // 1. Reset, in an order that keeps runs independent:
  //    a. chain head back to the start and paused, so the indexer has nothing new to do;
  //    b. empty the database, so the worker stops sending the previous run's deliveries;
  //    c. wait out any send already in progress (delivery timeout), then reset the receivers.
  await waitFor("API", () => gql(`{ health { database { ok } } }`).then((h: any) => h.health.database.ok || false));
  await control(MOCK_RPC_URL, "/control/reset");
  await sleep(2500); // let any in-flight indexer tick finish before truncating
  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  await db.query("TRUNCATE delivery, subscription, timelock_change, vault_event, sync_cursor");
  await db.end();
  await sleep(Number(process.env.DELIVERY_TIMEOUT_MS ?? 5000) + 1000);
  await control(RECEIVERS_URL, "/control/reset");
  console.log(`${c.dim}reset: chain head rewound, receivers cleared, database emptied (vault metadata kept)${c.reset}`);

  // 2. Subscribe. start_block = current head (before every vault existed), so the whole history counts as new.
  const vaults = (await gql(`{ vaults { address name } }`)).vaults as { address: string; name: string }[];
  const splits = vaults.find((v) => v.name === "Splits Earn USDC")?.address;
  const endpoints: { path: string; vaults?: string[]; note: string }[] = [
    { path: "/ok", note: "always 200" },
    { path: "/flaky", note: "fails twice per alert, then 200" },
    { path: "/down", note: "always 500" },
    { path: "/slow", note: "answers after the worker's timeout", ...(splits ? { vaults: [splits] } : {}) },
  ];
  const subs: Record<string, string> = {};
  for (const e of endpoints) {
    const r = await gql(
      `mutation($input: CreateSubscriptionInput!) { createSubscription(input: $input) { secret subscription { id } } }`,
      { input: { url: `${RECEIVERS_URL_FOR_SERVICE}${e.path}`, ...(e.vaults ? { vaults: e.vaults } : {}) } },
    );
    subs[e.path] = r.createSubscription.subscription.id;
    await control(RECEIVERS_URL, "/control/register", "POST", { path: e.path, secret: r.createSubscription.secret });
    console.log(`${c.dim}subscribed ${e.path.padEnd(7)} (${e.note}${e.vaults ? ", Splits Earn USDC only" : ""})${c.reset}`);
  }

  // 3. Play and print the timeline as the API reports it.
  const state = await control(MOCK_RPC_URL, `/control/play?speed=${encodeURIComponent(SPEED)}`);
  console.log(`\n${c.bold}playing ${state.fromBlock} → ${state.toBlock} at ${SPEED}${c.reset}\n`);
  const seen = new Map<string, string>(); // change id -> last printed status
  let lastDay = "";
  for (;;) {
    const st = await control(MOCK_RPC_URL, "/control/state", "GET");
    const data = await gql(`{
      health { indexer { lastBlock chainTime } }
      timelockChanges(limit: 1000) { id status summary submittedAt executableAt resolvedAt submitTx revokedBy vault { name } }
    }`);
    // Between two polls a change may have been both submitted and resolved (replay runs fast), so emit one line per
    // lifecycle step we haven't printed yet, then sort the batch by chain time.
    const lines: { at: string; text: string }[] = [];
    for (const ch of data.timelockChanges) {
      const prev = seen.get(ch.id);
      if (prev === ch.status) continue;
      seen.set(ch.id, ch.status);
      const zeroNotice = ch.submittedAt === ch.executableAt;
      const notable = ch.status === "REVOKED" || (!zeroNotice && /cap|adapter|fee|Abdicate/i.test(ch.summary));
      if (TIMELINE === "none" || (TIMELINE === "notable" && !notable)) continue;
      const vault = ch.vault.name.padEnd(36);
      if (prev === undefined) {
        lines.push({
          at: ch.submittedAt,
          text: `${c.yellow}SUBMITTED${c.reset}  ${vault} ${ch.summary} ${c.dim}(executable ${day(ch.executableAt)})${c.reset}`,
        });
      }
      if (ch.status !== "PENDING") {
        const tag = ch.status === "EXECUTED" ? `${c.green}EXECUTED ${c.reset}` : `${c.red}REVOKED  ${c.reset}`;
        lines.push({ at: ch.resolvedAt, text: `${tag}  ${vault} ${ch.summary}` });
      }
    }
    lines.sort((a, b) => a.at.localeCompare(b.at));
    for (const l of lines) {
      if (l.at.slice(0, 7) !== lastDay) {
        lastDay = l.at.slice(0, 7);
        console.log(`${c.cyan}── ${lastDay} ──${c.reset}`);
      }
      console.log(`${day(l.at)}  ${l.text}`);
    }
    if (st.done && data.health.indexer && Number(data.health.indexer.lastBlock) >= st.toBlock - 50) break;
    await sleep(1000);
  }

  // 4. Settle deliveries, then report and check.
  console.log(`\n${c.bold}history replayed; waiting for webhook deliveries to settle (max ${SETTLE_TIMEOUT_S}s)…${c.reset}`);
  const counts = async () => {
    const d = await gql(`{ subscriptions { id deliveryCounts { pending delivered failed } } }`);
    const byId = new Map(d.subscriptions.map((s: any) => [s.id, s.deliveryCounts]));
    return Object.fromEntries(Object.entries(subs).map(([path, id]) => [path, byId.get(id)])) as Record<
      string,
      { pending: number; delivered: number; failed: number }
    >;
  };
  const settled = await waitFor(
    "deliveries to settle",
    async () => {
      const k = await counts();
      return Object.values(k).every((x) => x.pending === 0) ? k : false;
    },
    SETTLE_TIMEOUT_S,
  ).catch(() => counts());
  const received = await control(RECEIVERS_URL, "/received", "GET");
  const statusCounts = Object.fromEntries(
    await Promise.all(
      (["PENDING", "EXECUTED", "REVOKED"] as const).map(async (s) => [s, (await gql(`{ timelockChanges(status: ${s}, limit: 1000) { id } }`)).timelockChanges.length]),
    ),
  );

  console.log(`\n${c.bold}deliveries (API view)       vs   receiver view${c.reset}`);
  for (const p of Object.keys(subs)) {
    const k = settled[p]!;
    const r = received[p];
    console.log(
      `${p.padEnd(7)} delivered ${String(k.delivered).padStart(4)}  failed ${String(k.failed).padStart(4)}  pending ${String(k.pending).padStart(3)}   |  requests ${String(r.requests).padStart(5)}  accepted ${String(r.accepted).padStart(4)}  bad signatures ${r.badSignatures}${r.unregistered ? `  ${c.dim}(+${r.unregistered} from a previous run)${c.reset}` : ""}`,
    );
  }

  const checks: [string, boolean, string][] = [
    ["changes by status match research §3", JSON.stringify(statusCounts) === JSON.stringify(EXPECTED_STATUS), JSON.stringify(statusCounts)],
    ["/ok received every alert exactly once", settled["/ok"]!.delivered === ALL_ALERTS && received["/ok"].accepted === ALL_ALERTS && received["/ok"].duplicatesAfterAccept === 0, `${received["/ok"].accepted}/${ALL_ALERTS}`],
    ["/flaky delivered everything after retries", settled["/flaky"]!.delivered === ALL_ALERTS && received["/flaky"].requests >= ALL_ALERTS * 3, `${received["/flaky"].requests} requests`],
    ["/down gave up after max attempts", settled["/down"]!.failed === ALL_ALERTS && settled["/down"]!.delivered === 0, `${settled["/down"]!.failed} failed`],
    ["/slow timed out (not delivered) without blocking others", settled["/slow"]!.delivered === 0 && settled["/slow"]!.failed + settled["/slow"]!.pending === SLOW_ALERTS, `${settled["/slow"]!.failed} failed, ${settled["/slow"]!.pending} pending`],
    ["no request had an invalid signature", Object.values(received).every((r: any) => r.badSignatures === 0), ""],
  ];
  console.log("");
  for (const [name, ok, detail] of checks) console.log(`${ok ? `${c.green}PASS` : `${c.red}FAIL`}${c.reset}  ${name}${detail ? ` ${c.dim}(${detail})${c.reset}` : ""}`);
  const failed = checks.filter(([, ok]) => !ok).length;
  console.log(failed ? `\n${c.red}${failed} check(s) failed${c.reset}` : `\n${c.green}all checks passed${c.reset}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(`${c.red}replay failed: ${(err as Error).message}${c.reset}`);
  process.exit(1);
});

/**
 * Delivery worker: sends queued alerts (the outbox) to subscriber webhooks. At-least-once, signed, with retries.
 *
 * Any number of workers can run: each claims rows with FOR UPDATE SKIP LOCKED and takes a short lease
 * (locked_until), then sends OUTSIDE any transaction, so a slow receiver never holds database locks.
 * If a worker dies mid-send, the lease expires and another worker retries; that's why receivers dedupe on
 * X-Delivery-Id.
 */
import http from "node:http";
import https from "node:https";
import type pg from "pg";
import type { Logger } from "../logger.js";
import { decryptSecret } from "./secrets.js";
import { DELIVERY_ID_HEADER, SIGNATURE_HEADER, sign } from "./signing.js";
import { guardedLookup } from "./url-guard.js";
import { sleep } from "../indexer/indexer.js";

/** Wait before retry N (1-based). Total ≈ 22.5h over 8 attempts; then the delivery is marked FAILED. */
export const RETRY_SCHEDULE_SECONDS = [30, 120, 600, 3600, 3 * 3600, 6 * 3600, 12 * 3600];
export function retryDelaySeconds(attemptsSoFar: number): number {
  return RETRY_SCHEDULE_SECONDS[Math.min(attemptsSoFar - 1, RETRY_SCHEDULE_SECONDS.length - 1)]!;
}

const LEASE_SECONDS = 30;

export interface WorkerOptions {
  encryptionKey: Buffer;
  maxAttempts: number;
  timeoutMs: number;
  concurrency: number;
  allowPrivate: boolean;
  pollIntervalMs?: number;
  /** Multiplies RETRY_SCHEDULE_SECONDS (1 = real schedule; the replay demo compresses it). */
  retryScale?: number;
  /** Max deliveries in flight per subscription, across all workers (fairness: one bad endpoint can't hog slots). */
  perSubscription?: number;
  /** Wall clock, injectable so tests can move time. */
  now?: () => Date;
}

interface ClaimedDelivery {
  id: string;
  subscription_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
  url: string;
  active: boolean;
  secret_ciphertext: Buffer;
  secret_iv: Buffer;
  secret_tag: Buffer;
}

export type SendOutcome = { ok: true; status: number } | { ok: false; status: number | null; error: string };

export class DeliveryWorker {
  private readonly now: () => Date;

  constructor(
    private readonly pool: pg.Pool,
    private readonly opts: WorkerOptions,
    private readonly log: Logger,
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  /** Claim up to `limit` due deliveries: bump attempts and take a lease, in one short statement. */
  async claim(limit: number): Promise<ClaimedDelivery[]> {
    const now = this.now();
    // Step 1: pick candidates fairly. At most `perSubscription` deliveries per subscription may be in flight
    // (leased) at once, counting what other workers already hold, so one slow or dead endpoint can't take every
    // slot. Within a subscription, oldest first.
    const candidates = await this.pool.query<{ id: string }>(
      `WITH inflight AS (
         SELECT subscription_id, count(*) AS n FROM delivery
          WHERE status = 'PENDING' AND locked_until >= $1 GROUP BY subscription_id
       ), ranked AS (
         SELECT d.id, d.next_attempt_at, d.subscription_id,
                row_number() OVER (PARTITION BY d.subscription_id ORDER BY d.next_attempt_at, d.id) AS rn
           FROM delivery d
          WHERE d.status = 'PENDING' AND d.next_attempt_at <= $1 AND (d.locked_until IS NULL OR d.locked_until < $1)
       )
       SELECT r.id FROM ranked r LEFT JOIN inflight i USING (subscription_id)
        WHERE r.rn + coalesce(i.n, 0) <= $3
        ORDER BY r.next_attempt_at LIMIT $2`,
      [now, limit, this.opts.perSubscription ?? 2],
    );
    if (candidates.rowCount === 0) return [];
    // Step 2: lease them. SKIP LOCKED + the lease re-check mean two workers can never take the same row.
    const r = await this.pool.query<ClaimedDelivery>(
      `WITH due AS (
         SELECT id FROM delivery
          WHERE id = ANY($2::uuid[]) AND status = 'PENDING' AND (locked_until IS NULL OR locked_until < $1)
          FOR UPDATE SKIP LOCKED
       )
       UPDATE delivery d
          SET attempts = d.attempts + 1, locked_until = $1::timestamptz + make_interval(secs => $3)
         FROM due, subscription s
        WHERE d.id = due.id AND s.id = d.subscription_id
       RETURNING d.id, d.subscription_id, d.event_type, d.payload, d.attempts,
                 s.url, s.active, s.secret_ciphertext, s.secret_iv, s.secret_tag`,
      [now, candidates.rows.map((c) => c.id), LEASE_SECONDS],
    );
    return r.rows;
  }

  /** Process one batch. Returns how many deliveries were attempted (0 = nothing due). */
  async runOnce(): Promise<number> {
    const batch = await this.claim(this.opts.concurrency);
    await Promise.all(batch.map((d) => this.deliver(d)));
    return batch.length;
  }

  private async deliver(d: ClaimedDelivery): Promise<void> {
    if (!d.active) {
      await this.finish(d, { ok: false, status: null, error: "subscription deactivated" }, true);
      return;
    }
    let secret: string;
    try {
      secret = decryptSecret(this.opts.encryptionKey, d.subscription_id, {
        ciphertext: d.secret_ciphertext,
        iv: d.secret_iv,
        tag: d.secret_tag,
      });
    } catch {
      // Wrong SECRET_ENCRYPTION_KEY or a tampered row: retrying won't help, and sending unsigned is not an option.
      await this.finish(d, { ok: false, status: null, error: "cannot decrypt signing secret" }, true);
      return;
    }
    const body = JSON.stringify({ deliveryId: d.id, ...d.payload });
    const signature = sign(secret, Math.floor(this.now().getTime() / 1000), body);
    const outcome = await this.post(d.url, body, {
      "content-type": "application/json",
      "user-agent": "vault-timelock-notifier/0.1",
      [DELIVERY_ID_HEADER]: d.id,
      [SIGNATURE_HEADER]: signature,
    });
    await this.finish(d, outcome, false);
  }

  /** Record the outcome: DELIVERED, a scheduled retry, or FAILED after the last attempt. */
  private async finish(d: ClaimedDelivery, outcome: SendOutcome, permanent: boolean) {
    const now = this.now();
    if (outcome.ok) {
      await this.pool.query(
        `UPDATE delivery SET status = 'DELIVERED', delivered_at = $2, last_status_code = $3, last_error = NULL,
                locked_until = NULL WHERE id = $1`,
        [d.id, now, outcome.status],
      );
      this.log.debug({ delivery: d.id, url: d.url, status: outcome.status }, "delivered");
      return;
    }
    const giveUp = permanent || d.attempts >= this.opts.maxAttempts;
    const next = new Date(now.getTime() + retryDelaySeconds(d.attempts) * 1000 * (this.opts.retryScale ?? 1));
    await this.pool.query(
      `UPDATE delivery SET status = $2, next_attempt_at = $3, last_status_code = $4, last_error = $5,
              locked_until = NULL WHERE id = $1`,
      [d.id, giveUp ? "FAILED" : "PENDING", giveUp ? now : next, outcome.status, outcome.error.slice(0, 500)],
    );
    this.log.warn(
      { delivery: d.id, url: d.url, attempt: d.attempts, status: outcome.status, error: outcome.error, nextAttemptAt: giveUp ? null : next },
      giveUp ? "delivery failed permanently" : "delivery failed; will retry",
    );
  }

  /** POST with a timeout, no redirects (a redirect could point at a private address), SSRF-safe DNS lookup. */
  post(url: string, body: string, headers: Record<string, string>): Promise<SendOutcome> {
    return new Promise((resolve) => {
      const u = new URL(url);
      const lib = u.protocol === "https:" ? https : http;
      const req = lib.request(
        u,
        {
          method: "POST",
          headers: { ...headers, "content-length": Buffer.byteLength(body) },
          timeout: this.opts.timeoutMs,
          ...(this.opts.allowPrivate ? {} : { lookup: guardedLookup }),
        },
        (res) => {
          res.resume(); // we don't need the body; drain it so the socket is released
          const status = res.statusCode ?? 0;
          res.on("end", () =>
            resolve(status >= 200 && status < 300 ? { ok: true, status } : { ok: false, status, error: `HTTP ${status}` }),
          );
        },
      );
      req.on("timeout", () => req.destroy(new Error(`timeout after ${this.opts.timeoutMs}ms`)));
      req.on("error", (err) => resolve({ ok: false, status: null, error: err.message }));
      req.end(body);
    });
  }

  /**
   * Continuous pool: keep up to `concurrency` sends in flight and claim new work as soon as a slot frees.
   * (An earlier version awaited whole batches, so one slow receiver stalled the rest of its batch: the replay
   * demo exposed it.)
   */
  async run(signal: AbortSignal): Promise<void> {
    const inflight = new Set<Promise<void>>();
    const poll = this.opts.pollIntervalMs ?? 1000;
    while (!signal.aborted) {
      try {
        const free = this.opts.concurrency - inflight.size;
        const batch = free > 0 ? await this.claim(free) : [];
        for (const d of batch) {
          const p: Promise<void> = this.deliver(d)
            .catch((err) => this.log.error({ err, delivery: d.id }, "delivery crashed; lease will expire and it will be retried"))
            .finally(() => inflight.delete(p));
          inflight.add(p);
        }
        if (batch.length === 0 || inflight.size >= this.opts.concurrency) {
          // Wake when a send finishes (a slot frees) or after the poll interval (new work may be due).
          await Promise.race([sleep(poll, signal), ...inflight]);
        }
      } catch (err) {
        this.log.error({ err }, "delivery worker claim failed");
        await sleep(5000, signal);
      }
    }
    await Promise.allSettled(inflight);
  }
}

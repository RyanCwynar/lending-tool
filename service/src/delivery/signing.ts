import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Webhook signature, same shape as Stripe's:  X-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256>
 * The HMAC covers `${t}.${rawBody}`, so the timestamp can't be changed without breaking the signature, and
 * receivers reject old timestamps, so a captured request can't be replayed later.
 */
export const SIGNATURE_HEADER = "x-signature";
export const DELIVERY_ID_HEADER = "x-delivery-id";

export function sign(secret: string, unixSeconds: number, rawBody: string): string {
  const mac = createHmac("sha256", secret).update(`${unixSeconds}.${rawBody}`).digest("hex");
  return `t=${unixSeconds},v1=${mac}`;
}

export type VerifyResult = { ok: true } | { ok: false; reason: "malformed" | "stale" | "mismatch" };

/** What a receiver does. Exported so the mock receivers (and integrators) use exactly the same check. */
export function verify(
  secret: string,
  header: string | undefined,
  rawBody: string,
  nowUnixSeconds: number,
  toleranceSeconds = 300,
): VerifyResult {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? "");
  if (!m) return { ok: false, reason: "malformed" };
  const t = Number(m[1]);
  if (Math.abs(nowUnixSeconds - t) > toleranceSeconds) return { ok: false, reason: "stale" };
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex"), "hex");
  const given = Buffer.from(m[2]!, "hex");
  // Constant-time comparison, so response timing doesn't reveal how many bytes matched.
  return expected.length === given.length && timingSafeEqual(expected, given) ? { ok: true } : { ok: false, reason: "mismatch" };
}

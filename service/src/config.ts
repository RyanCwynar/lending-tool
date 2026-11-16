import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .default("false")
  .transform((v) => v === "true" || v === "1");

/** "0xabc…:37179342,0xdef…:45427904" → [{ address, startBlock }] (start block = vault creation block). */
const vaultList = z
  .string()
  .default("")
  .transform((raw, ctx) => {
    const out: { address: `0x${string}`; startBlock: number }[] = [];
    for (const item of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
      const m = /^(0x[0-9a-fA-F]{40}):(\d+)$/.exec(item);
      if (!m) {
        ctx.addIssue({ code: "custom", message: `VAULTS entry "${item}" must be address:startBlock` });
        return z.NEVER;
      }
      out.push({ address: m[1]!.toLowerCase() as `0x${string}`, startBlock: Number(m[2]) });
    }
    return out;
  });

const EnvSchema = z.object({
  DATABASE_URL: z.url(),
  RPC_URL: z.url(),
  CHAIN_ID: z.coerce.number().int().positive(),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  /** Which role this process runs. `all` runs every role in one process (local dev). */
  ROLE: z.enum(["api", "indexer", "worker", "all"]).default("all"),

  // Indexer
  VAULTS: vaultList,
  /** Only index blocks this far behind the head, so ordinary reorgs never reach us. */
  CONFIRMATIONS: z.coerce.number().int().min(0).default(10),
  POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(4000),
  /** Largest eth_getLogs block range to ask for. Halved automatically when a provider rejects it. */
  LOG_RANGE: z.coerce.number().int().min(1).default(10_000),
  /** How far back to rewind when the stored cursor hash is no longer canonical (a reorg deeper than CONFIRMATIONS). */
  REORG_REWIND_BLOCKS: z.coerce.number().int().min(1).default(500),

  // Delivery
  DELIVERY_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(8),
  DELIVERY_TIMEOUT_MS: z.coerce.number().int().min(100).default(5000),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(8),
  /** Base64 of 32 random bytes. Encrypts webhook signing secrets at rest. Needed by the api and worker roles. */
  SECRET_ENCRYPTION_KEY: z
    .string()
    .optional()
    .refine((v) => v === undefined || Buffer.from(v, "base64").length === 32, "must be base64 of exactly 32 bytes"),
  /** Allow webhook URLs on private/loopback networks. Only for local dev and the replay demo. */
  WEBHOOK_ALLOW_PRIVATE: bool,

  // API
  /** A pending change this far past executableAt (chain time) is reported as stale. */
  STALE_AFTER_DAYS: z.coerce.number().min(0).default(14),
});

export type Config = z.infer<typeof EnvSchema>;

/** Parse and validate env once at startup. A bad config should crash immediately, not on first use. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/** The signing-secret key, required by roles that create or use subscriptions. */
export function requireEncryptionKey(config: Config): Buffer {
  if (!config.SECRET_ENCRYPTION_KEY) {
    throw new Error("SECRET_ENCRYPTION_KEY is required for the api and worker roles (base64 of 32 random bytes)");
  }
  return Buffer.from(config.SECRET_ENCRYPTION_KEY, "base64");
}

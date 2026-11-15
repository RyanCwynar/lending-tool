import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z.url(),
  RPC_URL: z.url(),
  CHAIN_ID: z.coerce.number().int().positive(),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
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

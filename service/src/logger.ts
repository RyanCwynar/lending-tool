import { pino } from "pino";

export function createLogger(level: string) {
  return pino({
    level,
    // Pretty output only in an interactive terminal. Containers get JSON lines.
    ...(process.stdout.isTTY ? { transport: { target: "pino-pretty" } } : {}),
  });
}

export type Logger = ReturnType<typeof createLogger>;

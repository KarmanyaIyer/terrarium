// Logs go to stderr; stdout is reserved for the {"port":N} handshake line.

type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = order[(process.env.TERRARIUM_LOG as Level) || "info"] ?? 20;

function write(level: Level, scope: string, msg: string, extra?: unknown): void {
  if (order[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.padEnd(5)} [${scope}] ${msg}`;
  if (extra === undefined) process.stderr.write(line + "\n");
  else process.stderr.write(line + " " + (extra instanceof Error ? extra.stack || extra.message : JSON.stringify(extra)) + "\n");
}

export function logger(scope: string) {
  return {
    debug: (msg: string, extra?: unknown) => write("debug", scope, msg, extra),
    info: (msg: string, extra?: unknown) => write("info", scope, msg, extra),
    warn: (msg: string, extra?: unknown) => write("warn", scope, msg, extra),
    error: (msg: string, extra?: unknown) => write("error", scope, msg, extra),
  };
}

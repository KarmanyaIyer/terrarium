// Terrarium backend entry. Prints exactly one handshake line on stdout: {"port":N}. Everything else goes to stderr.

import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createApiServer } from "./server/http.ts";
import { logger } from "./util/log.ts";

const log = logger("main");

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await createApp(config);
  const api = createApiServer(app);
  const port = await api.listen(config.port);
  process.stdout.write(`${JSON.stringify({ port })}\n`);

  if (config.tokenGenerated) {
    if (config.dev) {
      process.stderr.write(`terrarium: dev token ${config.token}\n`);
      process.stderr.write(`terrarium: UI http://localhost:5173/#url=${encodeURIComponent(`http://127.0.0.1:${port}`)}&token=${config.token}\n`);
    } else {
      log.warn("TERRARIUM_TOKEN not set; generated a token that no client knows");
    }
  }

  let stopping = false;
  const shutdown = (why: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`shutting down (${why})`);
    const force = setTimeout(() => {
      log.error("shutdown timed out; exiting");
      process.exit(1);
    }, 30_000);
    force.unref();
    void (async () => {
      await api.close().catch(() => undefined);
      await app.shutdown();
      process.exit(0);
    })();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  if (config.parentStdin) {
    // The parent (Tauri) holds our stdin open; EOF means it went away.
    process.stdin.on("end", () => shutdown("stdin closed"));
    process.stdin.on("close", () => shutdown("stdin closed"));
    process.stdin.resume();
  }
}

main().catch((err) => {
  log.error("startup failed", err);
  process.exit(1);
});

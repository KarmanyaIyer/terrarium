// Parent-death guard for one simulated worker. This process stays responsive when the sandboxed worker is CPU
// wedged. Backend stdin EOF or a termination signal closes the worker pipe, then kills it if it cannot exit.

import { spawn } from "node:child_process";
import { closeSync, writeSync } from "node:fs";

interface GuardConfig {
  sandbox: string;
  profile: string;
  node: string;
  worker: string;
  workerArgs?: string[];
  env: Record<string, string>;
}

const raw = process.argv[2];
if (!raw) process.exit(64);
let config: GuardConfig;
try {
  config = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as GuardConfig;
} catch {
  process.exit(64);
}

const child = spawn(config.sandbox, ["-p", config.profile, config.node, "--max-old-space-size=768", "--disable-warning=ExperimentalWarning", config.worker, ...(config.workerArgs ?? [])], {
  cwd: "/",
  stdio: ["pipe", "pipe", "pipe"],
  env: config.env,
});

try {
  writeSync(3, `${JSON.stringify({ pid: child.pid })}\n`);
  closeSync(3);
} catch {}
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
process.stdin.pipe(child.stdin);

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  child.stdin.end();
  const timer = setTimeout(() => child.kill("SIGKILL"), 500);
  timer.unref();
};
process.stdin.on("end", stop);
process.stdin.on("close", stop);
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, stop);

child.on("error", (err) => {
  process.stderr.write(`sim guard: ${err.message}\n`);
  process.exit(70);
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 128 : 0)));

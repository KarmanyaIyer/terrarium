import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { SimRuntime, seedState } from "./runtime.ts";

const worker = new URL("./hostile-worker.fixture.ts", import.meta.url).pathname;
const parentFixture = new URL("./wedged-parent.fixture.ts", import.meta.url).pathname;
const dirs: string[] = [];
const processes = new Set<number>();
const sim = { python: false, javascript: false, maxTotalBytes: 8 * 1024 * 1024 };

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "terrarium-supervisor-"));
  dirs.push(dir);
  writeFileSync(join(dir, "state.json"), JSON.stringify(seedState()));
  return dir;
}

function exists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function untilGone(pid: number): Promise<void> {
  for (let i = 0; i < 100 && exists(pid); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(exists(pid), false, `pid ${pid} is still alive`);
}

after(async () => {
  for (const pid of processes) {
    if (!exists(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  await Promise.all([...processes].map((pid) => untilGone(pid).catch(() => {})));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

for (const mode of ["invalid-json", "unsolicited", "malformed-reply", "fetch-flood"] as const) {
  test(`a ${mode} worker is rejected and terminated`, async () => {
    const rt = new SimRuntime(mode, tempDir(), sim, "off", { workerPath: worker, workerArgs: [mode] });
    await assert.rejects(rt.start(), /protocol violation|exited|start/i);
    assert.equal(rt.isRunning(), false);
    if (rt.pid) await untilGone(rt.pid);
    if (rt.guardPid) await untilGone(rt.guardPid);
  });
}

test("dump chunks cannot accumulate past the configured filesystem size", async () => {
  const rt = new SimRuntime("giant-dump", tempDir(), sim, "off", { workerPath: worker, workerArgs: ["giant-dump"] });
  await rt.start();
  const workerPid = rt.pid!;
  const guardPid = rt.guardPid!;
  await assert.rejects(rt.checkpoint(), /dump exceeded|protocol violation|exited/i);
  await untilGone(workerPid);
  await untilGone(guardPid);
  assert.equal(rt.isRunning(), false);
});

test("a CPU-wedged worker dies when its backend parent is SIGKILLed", async () => {
  const dir = tempDir();
  const backend = spawn(process.execPath, [parentFixture, dir, worker], { stdio: ["ignore", "pipe", "inherit"] });
  assert.ok(backend.pid);
  processes.add(backend.pid!);
  const pids = await new Promise<{ guardPid: number; workerPid: number }>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("fixture did not report pids")), 20_000);
    backend.stdout!.setEncoding("utf8");
    backend.stdout!.on("data", (text: string) => {
      output += text;
      const nl = output.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(timer);
      resolve(JSON.parse(output.slice(0, nl)) as { guardPid: number; workerPid: number });
    });
    backend.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`fixture exited before reporting pids: ${code ?? signal}`));
    });
  });
  processes.add(pids.guardPid);
  processes.add(pids.workerPid);
  process.kill(backend.pid!, "SIGKILL");
  await untilGone(backend.pid!);
  await untilGone(pids.guardPid);
  await untilGone(pids.workerPid);
});

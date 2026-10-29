// VMMs never outlive their backend: the guard stops a VMM when its backend is SIGKILLed, and the startup reaper stops
// VMMs whose backend is gone, but only when the pid still names the recorded process (start time and command line).
// Fake VMMs are `sleep` processes. The real-VM case (krun) is opt-in: TERRARIUM_VM_TESTS=1.

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { dataDir } from "./gondolin.ts";
import { procIdentity, reapOrphanVmms } from "./reaper.ts";

const REAPER = path.join(import.meta.dirname, "reaper.ts");
const DRIVER = path.join(import.meta.dirname, "driver.ts");
let tmp = "";
const spawned: ChildProcess[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "terrarium-reaper-"));
});

after(() => {
  for (const c of spawned) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  fs.rmSync(tmp, { recursive: true, force: true });
});

function track(c: ChildProcess): ChildProcess {
  spawned.push(c);
  return c;
}

const alive = async (pid: number) => (await procIdentity(pid)) !== null;

async function gone(pid: number, ms: number): Promise<boolean> {
  for (let t = 0; t < ms; t += 100) {
    if (!(await alive(pid))) return true;
    await sleep(100);
  }
  return !(await alive(pid));
}

/** A stand-in backend: starts `sleep` as its VMM, arms a guard for it and prints both pids. */
async function fakeBackend(runDir: string, opts: { disarm?: boolean } = {}): Promise<{ backend: ChildProcess; vmm: number }> {
  const script = path.join(tmp, `backend-${Math.random().toString(36).slice(2)}.ts`);
  fs.writeFileSync(
    script,
    `import { spawn } from "node:child_process";
import { VmmGuard } from ${JSON.stringify(REAPER)};
const vmm = spawn("/bin/sleep", ["300"], { stdio: "ignore" });
const guard = await VmmGuard.arm(vmm.pid, "env-test", ${JSON.stringify(runDir)});
if (${opts.disarm ? "true" : "false"}) guard.disarm();
process.stdout.write(JSON.stringify({ vmm: vmm.pid }) + "\\n");
setInterval(() => {}, 1 << 30);
`,
  );
  const backend = track(spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "inherit"] }));
  const line = await new Promise<string>((resolve, reject) => {
    let buf = "";
    backend.stdout!.on("data", (d) => {
      buf += d;
      if (buf.includes("\n")) resolve(buf.split("\n")[0]);
    });
    backend.on("exit", (code) => reject(new Error(`fake backend exited ${code}`)));
  });
  return { backend, vmm: JSON.parse(line).vmm as number };
}

test("the guard stops the VMM when its backend is SIGKILLed", async () => {
  const runDir = path.join(tmp, "run-guard");
  const { backend, vmm } = await fakeBackend(runDir);
  assert.ok(await alive(vmm));
  assert.ok(fs.existsSync(path.join(runDir, `${vmm}.json`)), "the VMM is recorded");
  backend.kill("SIGKILL");
  assert.ok(await gone(vmm, 5000), "VMM still running 5 s after its backend was killed");
  // The record outlives the backend; the next startup finds its VMM gone and drops it.
  assert.equal(await reapOrphanVmms(runDir), 0);
  assert.deepEqual(fs.readdirSync(runDir), []);
});

test("a disarmed guard (VM stopped on purpose) leaves the pid alone", async () => {
  const runDir = path.join(tmp, "run-disarm");
  const { backend, vmm } = await fakeBackend(runDir, { disarm: true });
  assert.deepEqual(fs.existsSync(runDir) ? fs.readdirSync(runDir) : [], [], "disarm drops the record");
  backend.kill("SIGKILL");
  await sleep(1500);
  assert.ok(await alive(vmm), "a disarmed guard killed the pid");
  process.kill(vmm, "SIGKILL");
});

test("startup reaping stops only processes it can prove are VMMs of a dead backend", async () => {
  const runDir = path.join(tmp, "run-startup");
  fs.mkdirSync(runDir, { recursive: true });
  // A backend that is gone.
  const dead = track(spawn("/bin/sleep", ["0.5"]));
  const exited = new Promise((r) => dead.once("exit", r));
  const deadOwner = { pid: dead.pid!, identity: await procIdentity(dead.pid!) };
  await exited;
  assert.equal(await alive(deadOwner.pid), false);
  const liveOwner = { pid: process.pid, identity: await procIdentity(process.pid) };

  const proc = async () => {
    const c = track(spawn("/bin/sleep", ["300"], { stdio: "ignore" }));
    for (let i = 0; i < 50 && !(await procIdentity(c.pid!))?.includes("sleep"); i++) await sleep(20);
    return { pid: c.pid!, identity: (await procIdentity(c.pid!))! };
  };
  const write = (pid: number, identity: string, owner: { pid: number; identity: string | null }) =>
    fs.writeFileSync(path.join(runDir, `${pid}.json`), JSON.stringify({ pid, identity, envId: "e", owner, armedAt: 0 }));

  const orphan = await proc(); // left by the dead backend: stopped
  write(orphan.pid, orphan.identity, deadOwner);
  const reused = await proc(); // pid reused by an unrelated process: other start time
  write(reused.pid, reused.identity.replace(/\d{4}(\s)/, "1999$1"), deadOwner);
  const otherCmd = await proc(); // same pid and start time, different command line
  write(otherCmd.pid, otherCmd.identity.replace("sleep 300", "sleep 301"), deadOwner);
  const owned = await proc(); // its backend (this process) is alive
  write(owned.pid, owned.identity, liveOwner);
  fs.writeFileSync(path.join(runDir, "4242.json"), "{not json");

  assert.equal(await reapOrphanVmms(runDir), 1);
  assert.ok(await gone(orphan.pid, 1000), "orphan VMM stopped");
  assert.ok(await alive(reused.pid), "a reused pid was signalled");
  assert.ok(await alive(otherCmd.pid), "a process with another command line was signalled");
  assert.ok(await alive(owned.pid), "a live backend's VMM was signalled");
  assert.deepEqual(fs.readdirSync(runDir), [`${owned.pid}.json`], "stale and malformed records dropped, the live backend's kept");
});

const vmTests = process.env.TERRARIUM_VM_TESTS === "1";

test("a real krun VM dies with its SIGKILLed backend, and with the guard gone too, at the next startup", { skip: !vmTests && "set TERRARIUM_VM_TESTS=1" }, async () => {
  // Temp data dir sharing only the built images.
  const data = path.join(tmp, "data");
  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  fs.symlinkSync(path.join(dataDir(), "images"), path.join(data, "images"));
  const runDir = path.join(data, "run", "vmm");
  const script = path.join(tmp, "vm-backend.ts");
  fs.writeFileSync(
    script,
    `import { createVmDriver } from ${JSON.stringify(DRIVER)};
const d = createVmDriver();
const rt = await d.create({ id: process.argv[2], dir: ${JSON.stringify(path.join(data, "envs"))} + "/" + process.argv[2], network: "off", vm: { cpus: 1, memoryMiB: 512, diskMiB: 2048, backend: "krun" } });
await rt.start();
process.stdout.write(JSON.stringify({ vmm: rt.hostPid() }) + "\\n");
setInterval(() => {}, 1 << 30);
`,
  );
  const boot = async (id: string) => {
    const backend = track(spawn(process.execPath, [script, id], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, TERRARIUM_DATA: data } }));
    const line = await new Promise<string>((resolve, reject) => {
      let buf = "";
      backend.stdout!.on("data", (d) => {
        buf += d;
        if (buf.includes("\n")) resolve(buf.split("\n")[0]);
      });
      backend.on("exit", (code) => reject(new Error(`VM backend exited ${code}`)));
    });
    const vmm = JSON.parse(line).vmm as number;
    assert.match((await procIdentity(vmm)) ?? "", /krun/, "the VMM is the krun runner");
    return { backend, vmm };
  };

  const a = await boot("reap-a");
  a.backend.kill("SIGKILL");
  assert.ok(await gone(a.vmm, 10_000), "krun runner outlived its SIGKILLed backend");

  // Backend and guard both SIGKILLed (killall -9): the VM keeps running until the next backend starts.
  const b = await boot("reap-b");
  const guards = await new Promise<string>((resolve) => {
    const ps = spawn("/usr/bin/pgrep", ["-P", String(b.backend.pid), "-f", "terrarium-vmm-guard"]);
    let out = "";
    ps.stdout.on("data", (d) => (out += d));
    ps.on("exit", () => resolve(out));
  });
  const guardPids = guards.split(/\s+/).filter(Boolean).map(Number);
  assert.equal(guardPids.length, 1, `one guard per VM: ${guards}`);
  process.kill(guardPids[0], "SIGKILL");
  b.backend.kill("SIGKILL");
  await sleep(1500);
  assert.ok(await alive(b.vmm), "the VMM keeps running without its guard");
  // Gondolin's runner configs (temp dir) of both dead backends' VMMs are left behind until the next startup.
  const configs = fs.readdirSync(runDir).map((n) => / --config (\S+)/.exec(JSON.parse(fs.readFileSync(path.join(runDir, n), "utf8")).identity)![1]);
  assert.equal(configs.length, 2);
  assert.ok(configs.every((c) => fs.existsSync(c)));
  assert.equal(await reapOrphanVmms(runDir), 1);
  assert.ok(await gone(b.vmm, 5000), "startup reaping stopped the VMM");
  assert.deepEqual(fs.readdirSync(runDir), []);
  assert.ok(!configs.some((c) => fs.existsSync(c)), "runner configs removed");
});

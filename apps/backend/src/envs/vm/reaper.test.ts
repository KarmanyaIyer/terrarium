// VMMs never outlive their backend: the guard stops a VMM when its backend is SIGKILLed, and the startup reaper stops
// VMMs whose backend is gone, but only when the pid still names the recorded process (start time and command line).
// Fake VMMs are `sleep` processes. The real-VM case (krun) is opt-in: TERRARIUM_VM_TESTS=1.

import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { dataDir } from "./gondolin.ts";
import * as reaper from "./reaper.ts";
import { procIdentity, reapOrphanVmms } from "./reaper.ts";

const REAPER = path.join(import.meta.dirname, "reaper.ts");
const DRIVER = path.join(import.meta.dirname, "driver.ts");
let tmp = "";
/** Stand-in VMM binaries: `gondolin-krun-runner` and `qemu-system-aarch64` that only wait (a VMM's command line shape). */
let fakeKrun = "";
let fakeQemu = "";
const spawned: ChildProcess[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "terrarium-reaper-"));
  try {
    const bin = path.join(tmp, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "wait.c"), "#include <unistd.h>\nint main(void) { for (;;) pause(); }\n");
    execFileSync("/usr/bin/cc", ["-o", path.join(bin, "gondolin-krun-runner"), path.join(bin, "wait.c")], { stdio: "ignore" });
    fs.copyFileSync(path.join(bin, "gondolin-krun-runner"), path.join(bin, "qemu-system-aarch64"));
    fs.chmodSync(path.join(bin, "qemu-system-aarch64"), 0o755);
    fakeKrun = path.join(bin, "gondolin-krun-runner");
    fakeQemu = path.join(bin, "qemu-system-aarch64");
  } catch {
    // no C compiler: the tests that need a VMM-shaped process skip
  }
});

/** `ps` start time, read as UTC. */
function lstartUtc(identity: string): number {
  const m = /^\w{3} (\w{3}) +(\d+) (\d\d):(\d\d):(\d\d) (\d{4})/.exec(identity)!;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(m[1]);
  return Date.UTC(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
}

/** A dead backend, as a record's owner. */
async function goneOwner(): Promise<{ pid: number; identity: string | null }> {
  const dead = track(spawn("/bin/sleep", ["0.3"]));
  const exited = new Promise((r) => dead.once("exit", r));
  const owner = { pid: dead.pid!, identity: await procIdentity(dead.pid!) };
  await exited;
  return owner;
}

/** A Gondolin-style runner config name in the temp dir. */
const madeConfigs: string[] = [];
function runnerConfig(): string {
  const file = path.join(os.tmpdir(), `gondolin-krun-runner-${Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0")}.json`);
  fs.writeFileSync(file, "{}");
  madeConfigs.push(file);
  return file;
}

async function started(c: ChildProcess, want: string): Promise<{ pid: number; identity: string }> {
  for (let i = 0; i < 50 && !(await procIdentity(c.pid!))?.includes(want); i++) await sleep(20);
  return { pid: c.pid!, identity: (await procIdentity(c.pid!))! };
}

after(() => {
  for (const c of spawned) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  for (const f of madeConfigs) fs.rmSync(f, { force: true });
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
    fs.writeFileSync(path.join(runDir, `${pid}.json`), JSON.stringify({ pid, identity, envId: "e", owner, armedAt: 0, tz: "UTC0" }));

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

test("identities read start times in UTC, so a change of the Mac's timezone doesn't change them (review 3, #7)", async () => {
  const t0 = Date.now();
  const c = track(spawn("/bin/sleep", ["30"], { stdio: "ignore" }));
  const { identity } = await started(c, "sleep");
  assert.ok(Math.abs(lstartUtc(identity) - t0) < 2000, `${identity.slice(0, 24)} read as UTC is ${Math.round((lstartUtc(identity) - t0) / 60000)} min off`);
  c.kill("SIGKILL");
});

test("the guard compares in UTC whatever timezone it runs under (review 3, #7)", async () => {
  const vmm = await started(track(spawn("/bin/sleep", ["300"], { stdio: "ignore" })), "sleep");
  // Armed in one timezone, checked after the Mac moved to another.
  const guard = track(
    spawn("/bin/sh", ["-c", reaper.GUARD_SCRIPT ?? "exit 3", "terrarium-vmm-guard", String(vmm.pid)], {
      stdio: ["pipe", "ignore", "ignore"],
      env: { PATH: "/usr/bin:/bin", TZ: "Asia/Kolkata", TERRARIUM_VMM_IDENTITY: vmm.identity },
    }),
  );
  guard.stdin!.end(); // the backend died
  assert.ok(await gone(vmm.pid, 5000), "the guard didn't recognise its VMM under another TZ");
});

test("a backend killed while arming its guard leaves a pid-only record, and startup reaping stops that VMM (review 3, #7)", async (t) => {
  if (!fakeKrun) return t.skip("no C compiler for a VMM-shaped process");
  const runDir = path.join(tmp, "run-arming");
  const cfg = runnerConfig();
  const pidFile = path.join(tmp, "arming-vmm.pid");
  const script = path.join(tmp, "arming-backend.ts");
  // SIGKILLs itself right after the pid is first seen: before identity, guard or full record exist.
  fs.writeFileSync(
    script,
    `import { spawn } from "node:child_process";
import fs from "node:fs";
import * as reaper from ${JSON.stringify(REAPER)};
const since = Date.now();
const vmm = spawn(${JSON.stringify(fakeKrun)}, ["--config", ${JSON.stringify(cfg)}], { stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(pidFile)}, String(vmm.pid));
let seen = false;
const getPid = () => {
  if (!seen) {
    seen = true;
    queueMicrotask(() => process.kill(process.pid, "SIGKILL"));
  }
  return vmm.pid ?? null;
};
await reaper.guardWhenSpawned(getPid, new Promise(() => {}), { envId: "env-arming", dir: ${JSON.stringify(runDir)}, since, vmm: "krun", disk: "/nonexistent/disk.qcow2" });
setInterval(() => {}, 1 << 30);
`,
  );
  const backend = track(spawn(process.execPath, [script], { stdio: ["ignore", "ignore", "inherit"] }));
  const [, signal] = await new Promise<[number | null, string | null]>((r) => backend.once("exit", (code, sig) => r([code, sig])));
  assert.equal(signal, "SIGKILL");
  const vmm = Number(fs.readFileSync(pidFile, "utf8"));
  track({ pid: vmm, exitCode: null, signalCode: null, kill: () => { try { process.kill(vmm, "SIGKILL"); } catch {} } } as unknown as ChildProcess);
  assert.ok(await alive(vmm), "the VMM outlives its backend");
  const recs = fs.existsSync(runDir) ? fs.readdirSync(runDir) : [];
  assert.deepEqual(recs, [`${vmm}.json`], "the pid was recorded before the backend died");
  const rec = JSON.parse(fs.readFileSync(path.join(runDir, `${vmm}.json`), "utf8"));
  assert.equal(rec.identity, undefined, "pid-only: killed before its identity was known");
  assert.equal(await reapOrphanVmms(runDir), 1);
  assert.ok(await gone(vmm, 5000), "startup reaping stopped the VMM");
  assert.deepEqual(fs.readdirSync(runDir), []);
  assert.ok(!fs.existsSync(cfg), "its runner config was removed");
});

test("a pid-only record stops only a VMM of its kind that started between the boot and the pid being seen (review 3, #7)", async (t) => {
  if (!fakeKrun) return t.skip("no C compiler for a VMM-shaped process");
  const runDir = path.join(tmp, "run-pidonly");
  fs.mkdirSync(runDir, { recursive: true });
  const owner = await goneOwner();
  const disk = path.join(tmp, "envs", "vm_x", "disk.qcow2");
  const write = (pid: number, rec: Record<string, unknown>) =>
    fs.writeFileSync(path.join(runDir, `${pid}.json`), JSON.stringify({ pid, envId: "e", owner, armedAt: 0, tz: "UTC0", vmm: "krun", disk, ...rec }));
  const run = async (bin: string, args: string[], want: string) => {
    const before = Date.now();
    const p = await started(track(spawn(bin, args, { stdio: "ignore" })), want);
    return { ...p, window: { since: before, seenAt: Date.now() } };
  };

  const qemu = await run(fakeQemu, ["-machine", "virt", "-drive", `file=${disk},format=qcow2,if=none,id=drive0`], "qemu-system");
  write(qemu.pid, { ...qemu.window, vmm: "qemu" }); // QEMU naming this env's disk: stopped
  const otherDisk = await run(fakeQemu, ["-drive", `file=${disk}.other,format=qcow2`], "qemu-system");
  write(otherDisk.pid, { ...otherDisk.window, vmm: "qemu" });
  const early = await run(fakeKrun, ["--config", runnerConfig()], "gondolin-krun-runner");
  write(early.pid, { since: early.window.since + 5000, seenAt: early.window.seenAt + 5000 }); // started before the boot
  const late = await run(fakeKrun, ["--config", runnerConfig()], "gondolin-krun-runner");
  write(late.pid, { since: late.window.since - 10_000, seenAt: late.window.since - 5000 }); // started after the pid was seen
  const notVmm = await run("/bin/sleep", ["300"], "sleep");
  write(notVmm.pid, notVmm.window);
  const wrongKind = await run(fakeKrun, ["--config", runnerConfig()], "gondolin-krun-runner");
  write(wrongKind.pid, { ...wrongKind.window, vmm: "qemu" });
  const outsideTmp = await run(fakeKrun, ["--config", path.join(tmp, "gondolin-krun-runner-0123abcd.json")], "gondolin-krun-runner");
  write(outsideTmp.pid, outsideTmp.window);

  assert.equal(await reapOrphanVmms(runDir), 1);
  assert.ok(await gone(qemu.pid, 5000), "the QEMU VMM was stopped");
  for (const [what, p] of Object.entries({ otherDisk, early, late, notVmm, wrongKind, outsideTmp })) assert.ok(await alive(p.pid), `${what} was signalled`);
  assert.deepEqual(fs.readdirSync(runDir), [], "records dropped either way");
});

test("records from before UTC pinning are still matched in local time (review 3, #7)", async () => {
  const runDir = path.join(tmp, "run-legacy");
  fs.mkdirSync(runDir, { recursive: true });
  const c = track(spawn("/bin/sleep", ["300"], { stdio: "ignore" }));
  await started(c, "sleep");
  const identity = (await procIdentity(c.pid!, { localTime: true }))!;
  const dead = track(spawn("/bin/sleep", ["0.3"]));
  const exited = new Promise((r) => dead.once("exit", r));
  const owner = { pid: dead.pid!, identity: await procIdentity(dead.pid!, { localTime: true }) };
  await exited;
  fs.writeFileSync(path.join(runDir, `${c.pid}.json`), JSON.stringify({ pid: c.pid, identity, envId: "e", owner, armedAt: 0 }));
  assert.equal(await reapOrphanVmms(runDir), 1);
  assert.ok(await gone(c.pid!, 5000));
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

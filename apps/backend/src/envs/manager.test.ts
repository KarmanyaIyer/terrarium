// EnvManager lifecycle with a fake VM driver: the 2-VM cap holds under concurrent starts, forks and seeded
// creates (review 1, #7) and when a snapshot, fork or reset takes a running VM down (review 2, #6); facts are
// gathered on every start and after a reset.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Hub } from "../hub.ts";
import { Store } from "../store/db.ts";
import { EnvManager, MAX_RUNNING_VMS } from "./manager.ts";
import type { EnvDriver, EnvRuntime } from "./types.ts";

let dir: string;
let store: Store;
let envs: EnvManager;
let live = 0;
let peak = 0;
let factsCalls = 0;
const writes: string[] = [];
const vms = new Map<string, FakeVm>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FakeVm implements Partial<EnvRuntime> {
  readonly type = "vm" as const;
  private running = false;
  readonly id: string;
  readonly dir: string;
  constructor(id: string, dir: string) {
    this.id = id;
    this.dir = dir;
  }
  async start() {
    if (this.running) return;
    live++;
    peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 30)); // boots overlap unless something serializes them
    this.running = true;
  }
  async stop() {
    if (!this.running) return;
    this.running = false;
    live--;
  }
  isRunning() {
    return this.running;
  }
  /** Old driver behaviour: snapshot and restore boot a VM they stopped again by themselves. */
  static rebootsItself = false;
  static writeMs = 0;
  async writeFile(path: string) {
    assert.ok(this.running, `${this.id}: seeded while not running`);
    if (FakeVm.writeMs) await sleep(FakeVm.writeMs);
    assert.ok(this.running, `${this.id}: stopped halfway through seeding`);
    writes.push(`${this.id}:${path}`);
  }
  /** Like the VM driver: a running VM is shut down for the copy (which takes a moment). */
  private async whileDown(fn: () => void) {
    const wasRunning = this.running;
    await this.stop();
    await sleep(20);
    fn();
    if (wasRunning && FakeVm.rebootsItself) await this.start();
  }
  async snapshot(dest: string) {
    await this.whileDown(() => {
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, "disk"), "x");
    });
    return { bytes: 1 };
  }
  async restore() {
    await this.whileDown(() => {});
  }
  async destroy() {
    await this.stop();
  }
  async setNetwork() {}
  onNet() {
    return () => {};
  }
  async facts() {
    factsCalls++;
    return { kind: "vm" as const, isolation: `fake ${factsCalls}`, user: "agent", workdir: "/workspace", mounts: [], hostFoldersMounted: false as const, gatheredAt: Date.now() };
  }
  async resources() {
    return null;
  }
  async killAgentProcesses() {}
}

const fakeDriver = {
  type: "vm",
  async create(spec) {
    assert.equal(spec.seedFiles, undefined, "the VM driver is never asked to boot for seeding");
    mkdirSync(spec.dir, { recursive: true });
    const vm = new FakeVm(spec.id, spec.dir);
    vms.set(spec.id, vm);
    return vm as unknown as EnvRuntime;
  },
  async open(spec) {
    const vm = new FakeVm(spec.id, spec.dir);
    vms.set(spec.id, vm);
    return vm as unknown as EnvRuntime;
  },
  async check() {
    return { ok: true, detail: "fake" };
  },
} satisfies EnvDriver;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "terrarium-envs-"));
  store = new Store(join(dir, "db.sqlite"), join(dir, "blobs"));
  envs = new EnvManager({ store, hub: new Hub(), dataDir: dir, drivers: { vm: fakeDriver, sim: null } });
});

after(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("concurrent VM starts, seeded creates and seeded forks never run more than 2 VMs", async () => {
  const seed = [{ path: "/workspace/a.txt", content: "a" }];
  const made = await Promise.all([1, 2, 3, 4].map((i) => envs.create({ name: `vm${i}`, type: "vm", seedFiles: seed })));
  assert.ok(peak <= MAX_RUNNING_VMS, `peak ${peak} during seeded creates`);
  assert.equal(writes.length, 4);
  assert.equal(live, 0, "seeding stops what it started");
  // Five starts at once: idle VMs are stopped to make room, never more than two up.
  await Promise.allSettled(made.map((e) => envs.start(e.id)));
  assert.ok(peak <= MAX_RUNNING_VMS, `peak ${peak} during concurrent starts`);
  assert.ok(live <= MAX_RUNNING_VMS);
  // Forks with seed files while two VMs are running.
  await Promise.all([0, 1, 2].map((i) => envs.fork(made[i].id, { seedFiles: seed })));
  assert.ok(peak <= MAX_RUNNING_VMS, `peak ${peak} during seeded forks`);
  await envs.stopAll();
});

test("facts are gathered on every start and after a reset", async () => {
  const e = await envs.create({ name: "facts", type: "vm" });
  const n0 = factsCalls;
  await envs.start(e.id);
  assert.equal(factsCalls, n0 + 1);
  await envs.stop(e.id);
  await envs.start(e.id);
  assert.equal(factsCalls, n0 + 2, "a second start gathers again");
  await envs.reset(e.id);
  assert.equal(factsCalls, n0 + 3, "a reset of a running env gathers again");
  assert.match(envs.get(e.id).facts?.isolation ?? "", /fake/);
  await envs.stop(e.id);
  await envs.reset(e.id);
  assert.equal(envs.get(e.id).facts, undefined, "a reset of a stopped env drops the old facts until the next start");
  await envs.stopAll();
});

/** Status shown for every VM env matches whether its VM is really up. */
function assertStatusesTrue() {
  for (const e of envs.list()) {
    const up = vms.get(e.id)?.isRunning() ?? false;
    assert.equal(e.status === "running" || e.status === "busy", up, `${e.name}: status ${e.status} but VM ${up ? "up" : "down"}`);
  }
}

async function until(cond: () => boolean, what: string) {
  for (let i = 0; i < 200 && !cond(); i++) await sleep(1);
  assert.ok(cond(), what);
}

async function settleAll() {
  for (const e of envs.list()) envs.release(e.id, `sess-${e.id}`);
  await envs.stopAll();
  live = [...vms.values()].filter((v) => v.isRunning()).length;
}

for (const rebootsItself of [false, true]) {
  test(`snapshot, fork and reset of a running VM never let a third VM in (review 2, #6; driver reboots itself: ${rebootsItself})`, async () => {
    FakeVm.rebootsItself = rebootsItself;
    try {
      const [a, b, c] = await Promise.all(["A", "B", "C"].map((n) => envs.create({ name: `${n}${rebootsItself}`, type: "vm" })));
      const ops: [string, () => Promise<unknown>][] = [
        ["snapshot", () => envs.snapshot(b.id)],
        ["fork", () => envs.fork(b.id, {})],
        ["reset", () => envs.reset(b.id)],
      ];
      for (const [name, op] of ops) {
        await envs.acquire(a.id, `sess-${a.id}`); // A busy with a session
        await envs.start(b.id); // B running, idle
        peak = live;
        // B goes down inside the op; C starts while it is down.
        const pending = op();
        await until(() => !vms.get(b.id)!.isRunning(), `${name}: B goes down`);
        const startC = envs.start(c.id);
        const results = await Promise.allSettled([pending, startC]);
        assert.equal(results[0].status, "fulfilled", `${name}: ${(results[0] as PromiseRejectedResult).reason ?? ""}`);
        assert.equal(results[1].status, "fulfilled", `${name}: start C ${(results[1] as PromiseRejectedResult).reason ?? ""}`);
        assert.ok(peak <= MAX_RUNNING_VMS, `${name}: peak ${peak} VMs`);
        assert.equal(live, MAX_RUNNING_VMS);
        assert.equal(envs.get(c.id).status, "running", `${name}: C got B's slot after B came back`);
        assert.equal(envs.get(b.id).status, "stopped", `${name}: B was stopped to make room`);
        assertStatusesTrue();
        await settleAll();
      }
    } finally {
      FakeVm.rebootsItself = false;
      await settleAll();
    }
  });
}

test("making room waits for the idle VM's own snapshot instead of deadlocking or stopping it halfway (review 2, #6)", async () => {
  const [a, b, c] = await Promise.all(["A", "B", "C"].map((n) => envs.create({ name: `lock-${n}`, type: "vm" })));
  await envs.acquire(a.id, `sess-${a.id}`);
  await envs.start(b.id);
  peak = live;
  // C's start takes the boot lock first; B's snapshot then holds B's mutex and waits for that lock.
  const startC = envs.start(c.id);
  const snap = envs.snapshot(b.id);
  const timeout = sleep(5000).then(() => "timeout");
  const raced = await Promise.race([Promise.allSettled([startC, snap]), timeout]);
  assert.notEqual(raced, "timeout", "deadlock between the boot lock and B's mutex");
  const [rc, rs] = raced as PromiseSettledResult<unknown>[];
  assert.equal(rs.status, "fulfilled");
  assert.equal(rc.status, "fulfilled", String((rc as PromiseRejectedResult).reason ?? ""));
  assert.ok(peak <= MAX_RUNNING_VMS, `peak ${peak}`);
  assertStatusesTrue();
  await settleAll();
});

test("a seeded create isn't stopped halfway through to make room for another VM (review 2, #6)", async () => {
  const [a, c] = await Promise.all(["A", "C"].map((n) => envs.create({ name: `seed-${n}`, type: "vm" })));
  await envs.acquire(a.id, `sess-${a.id}`);
  FakeVm.writeMs = 10;
  try {
    peak = live;
    const files = [1, 2, 3, 4, 5].map((i) => ({ path: `/workspace/f${i}`, content: "x" }));
    const created = envs.create({ name: "seed-X", type: "vm", seedFiles: files });
    await until(() => [...vms.values()].filter((v) => v.isRunning()).length === 2, "X boots for seeding");
    const startC = envs.start(c.id);
    const [rx, rc] = await Promise.allSettled([created, startC]);
    assert.equal(rx.status, "fulfilled", String((rx as PromiseRejectedResult).reason ?? ""));
    assert.equal(rc.status, "fulfilled", String((rc as PromiseRejectedResult).reason ?? ""));
    assert.ok(peak <= MAX_RUNNING_VMS, `peak ${peak}`);
    assertStatusesTrue();
  } finally {
    FakeVm.writeMs = 0;
    await settleAll();
  }
});

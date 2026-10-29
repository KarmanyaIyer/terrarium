// EnvManager lifecycle with a fake VM driver: the 2-VM cap holds under concurrent starts, forks and seeded
// creates (review 1, #7), and facts are gathered on every start and after a reset.

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
  async writeFile(path: string) {
    assert.ok(this.running, `${this.id}: seeded while not running`);
    writes.push(`${this.id}:${path}`);
  }
  async snapshot(dest: string) {
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "disk"), "x");
    return { bytes: 1 };
  }
  async restore() {}
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
    return new FakeVm(spec.id, spec.dir) as unknown as EnvRuntime;
  },
  async open(spec) {
    return new FakeVm(spec.id, spec.dir) as unknown as EnvRuntime;
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

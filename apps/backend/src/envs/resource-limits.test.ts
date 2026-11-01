import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Hub } from "../hub.ts";
import { ResourceBudgets, type BudgetTrip } from "../resource-budgets.ts";
import { Store } from "../store/db.ts";
import { EnvManager } from "./manager.ts";
import type { EnvCreateSpec, EnvDriver, EnvRuntime, NetAttempt, NetworkGate } from "./types.ts";

const MiB = 1024 * 1024;

async function until(fn: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

class FakeSim implements Partial<EnvRuntime> {
  readonly type = "sim" as const;
  readonly id: string;
  readonly dir: string;
  running = false;
  terminated = 0;
  gate: NetworkGate | null = null;
  listeners = new Set<(attempt: NetAttempt) => void>();

  constructor(id: string, dir: string) {
    this.id = id;
    this.dir = dir;
  }
  async start() {
    this.running = true;
  }
  async stop() {
    this.running = false;
  }
  async terminate() {
    this.terminated++;
    this.running = false;
  }
  isRunning() {
    return this.running;
  }
  setNetworkGate(gate: NetworkGate | null) {
    this.gate = gate;
  }
  onNet(listener: (attempt: NetAttempt) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(attempt: NetAttempt) {
    for (const listener of this.listeners) listener(attempt);
  }
  async facts() {
    return { kind: "sim" as const, isolation: "fake", user: "agent", workdir: "/workspace", mounts: [], hostFoldersMounted: false as const, gatheredAt: Date.now() };
  }
  async resources() {
    return null;
  }
  async snapshot(dest: string) {
    mkdirSync(dest, { recursive: true });
    return { bytes: 0 };
  }
  async restore() {}
  async killAgentProcesses() {}
}

interface Fixture {
  dir: string;
  store: Store;
  budgets: ResourceBudgets;
  envs: EnvManager;
  runtimes: Map<string, FakeSim>;
  trips: BudgetTrip[];
  close(): Promise<void>;
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "terrarium-resource-limits-"));
  const store = new Store(join(dir, "db.sqlite"), join(dir, "blobs"));
  const budgets = new ResourceBudgets({ store, dataDir: dir });
  const runtimes = new Map<string, FakeSim>();
  const driver: EnvDriver = {
    type: "sim",
    async create(spec: EnvCreateSpec) {
      mkdirSync(spec.dir, { recursive: true });
      const rt = new FakeSim(spec.id, spec.dir);
      runtimes.set(spec.id, rt);
      return rt as unknown as EnvRuntime;
    },
    async open(spec) {
      const rt = new FakeSim(spec.id, spec.dir);
      runtimes.set(spec.id, rt);
      return rt as unknown as EnvRuntime;
    },
    async check() {
      return { ok: true, detail: "fake" };
    },
  };
  const envs = new EnvManager({ store, hub: new Hub(), dataDir: dir, drivers: { sim: driver, vm: null }, budgets });
  const trips: BudgetTrip[] = [];
  budgets.onTrip = (trip) => trips.push(trip);
  return {
    dir,
    store,
    budgets,
    envs,
    runtimes,
    trips,
    async close() {
      await envs.stopAll();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("at the worker cap a simulated env waits for a slot, first come first served", async () => {
  const f = fixture();
  try {
    f.budgets.update({ maxSimWorkers: 1 });
    const a = await f.envs.create({ name: "a", type: "sim" });
    const b = await f.envs.create({ name: "b", type: "sim" });
    const c = await f.envs.create({ name: "c", type: "sim" });
    await f.envs.acquire(a.id, "ses-a");
    const notes: string[] = [];
    const order: string[] = [];
    const gotB = f.envs.acquire(b.id, "ses-b", (d) => notes.push(d)).then(() => order.push("b"));
    await until(() => f.envs.get(b.id).statusDetail?.startsWith("Waiting for a free simulated shell") === true);
    assert.match(notes[0] ?? "", /session "ses-a"|ses-a/);
    const gotC = f.envs.acquire(c.id, "ses-c").then(() => order.push("c"));
    await until(() => f.envs.get(c.id).status === "starting");
    assert.equal(f.runtimes.get(a.id)?.isRunning(), true);
    assert.equal(f.runtimes.get(b.id)?.isRunning() ?? false, false);
    f.envs.release(a.id, "ses-a");
    await gotB;
    assert.deepEqual(order, ["b"]);
    assert.equal(f.runtimes.get(a.id)?.isRunning(), false, "the idle worker made room");
    f.envs.release(b.id, "ses-b");
    await gotC;
    assert.deepEqual(order, ["b", "c"]);
    f.envs.release(c.id, "ses-c");
  } finally {
    await f.close();
  }
});

test("a Start press at the cap is told who holds the slots, with no wait; an eval case's start waits", async () => {
  const f = fixture();
  try {
    f.budgets.update({ maxSimWorkers: 1 });
    const a = await f.envs.create({ name: "held", type: "sim" });
    const b = await f.envs.create({ name: "b", type: "sim" });
    await f.envs.acquire(a.id, "ses-a");
    await assert.rejects(f.envs.start(b.id), (e: Error & { status?: number }) => e.status === 409 && /^1 simulated shell is in use \(held: /.test(e.message));
    assert.equal(f.envs.get(b.id).status, "stopped");
    const waits = f.envs.start(b.id, { queue: true });
    await until(() => f.envs.get(b.id).statusDetail?.startsWith("Waiting for a free simulated shell") === true);
    f.envs.release(a.id, "ses-a");
    assert.equal((await waits).status, "running");
  } finally {
    await f.close();
  }
});

test("a cancel between waits isn't lost", async () => {
  const f = fixture();
  try {
    f.budgets.update({ maxSimWorkers: 1 });
    const a = await f.envs.create({ name: "a", type: "sim" });
    const b = await f.envs.create({ name: "b", type: "sim" });
    await f.envs.acquire(a.id, "ses-a");
    const gotB = f.envs.acquire(b.id, "ses-b");
    await until(() => f.envs.get(b.id).status === "starting");
    // the worst moment: the wake and the cancel land together, so the waiter holds no timer when the cancel arrives
    (f.envs as unknown as { wakeSimQueue(): void }).wakeSimQueue();
    f.envs.cancelQueued(b.id);
    await assert.rejects(gotB, /stopped while waiting/);
    assert.equal(f.runtimes.get(b.id)?.isRunning() ?? false, false);
    f.envs.release(a.id, "ses-a");
  } finally {
    await f.close();
  }
});

test("stopping a queued simulated env ends its wait and leaves it stopped", async () => {
  const f = fixture();
  try {
    f.budgets.update({ maxSimWorkers: 1 });
    const a = await f.envs.create({ name: "a", type: "sim" });
    const b = await f.envs.create({ name: "b", type: "sim" });
    await f.envs.acquire(a.id, "ses-a");
    const gotB = f.envs.acquire(b.id, "ses-b");
    await until(() => f.envs.get(b.id).status === "starting");
    f.envs.cancelQueued(b.id);
    await assert.rejects(gotB, /stopped while waiting/);
    assert.equal(f.envs.get(b.id).status, "stopped");
    assert.equal(f.runtimes.get(a.id)?.isRunning(), true);
    f.envs.release(a.id, "ses-a");
  } finally {
    await f.close();
  }
});

test("raising the worker cap frees a queued simulated env", async () => {
  const f = fixture();
  try {
    f.budgets.update({ maxSimWorkers: 1 });
    const a = await f.envs.create({ name: "a", type: "sim" });
    const b = await f.envs.create({ name: "b", type: "sim" });
    await f.envs.acquire(a.id, "ses-a");
    const gotB = f.envs.acquire(b.id, "ses-b");
    await until(() => f.envs.get(b.id).status === "starting");
    f.budgets.update({ maxSimWorkers: 2 });
    await gotB;
    assert.equal(f.runtimes.get(a.id)?.isRunning(), true);
    assert.equal(f.runtimes.get(b.id)?.isRunning(), true);
    f.envs.release(a.id, "ses-a");
    f.envs.release(b.id, "ses-b");
  } finally {
    await f.close();
  }
});

for (const kind of ["rss", "cpu"] as const) {
  test(`host sampling terminates a simulated worker over its ${kind.toUpperCase()} lifetime budget`, async () => {
    const f = fixture();
    try {
      f.budgets.update({ simWorkerRssBytes: 256 * MiB, simWorkerCpuMs: 60_000 });
      const env = await f.envs.create({ name: kind, type: "sim" });
      await f.envs.acquire(env.id, `ses-${kind}`);
      const sample = kind === "rss" ? { rssBytes: 256 * MiB + 1, cpuPct: 0, cpuTimeMs: 0 } : { rssBytes: 1, cpuPct: 100, cpuTimeMs: 60_001 };
      await f.envs.enforceBudgets(new Map([[env.id, sample]]));
      await Promise.resolve();
      assert.equal(f.runtimes.get(env.id)?.terminated, 1);
      assert.equal(f.envs.get(env.id).status, "stopped");
      assert.match(f.envs.get(env.id).statusDetail ?? "", kind === "rss" ? /memory/ : /CPU time/);
      assert.equal(f.trips.at(-1)?.budget, kind === "rss" ? "sim_rss" : "sim_cpu");
      f.envs.release(env.id, `ses-${kind}`);
    } finally {
      await f.close();
    }
  });
}

test("host disk reserve terminates running work and reports a host-scoped trip", async () => {
  const f = fixture();
  try {
    const env = await f.envs.create({ name: "disk", type: "sim" });
    await f.envs.acquire(env.id, "ses-disk");
    f.budgets.freeDiskBytes = () => 0;
    await f.envs.enforceBudgets();
    await Promise.resolve();
    assert.equal(f.runtimes.get(env.id)?.terminated, 1);
    assert.equal(f.trips.at(-1)?.budget, "host_disk");
    assert.equal(f.trips.at(-1)?.scope, "host");
    f.envs.release(env.id, "ses-disk");
  } finally {
    await f.close();
  }
});

test("unique URL floods hit a pre-DNS token bucket and share one overflow row", async () => {
  const f = fixture();
  try {
    f.budgets.update({ networkBurst: 10, networkRefillPerSecond: 1, sessionNetworkRows: 1000 });
    const env = await f.envs.create({ name: "rate", type: "sim", network: "web" });
    const rt = (await f.envs.acquire(env.id, "ses-rate")) as unknown as FakeSim;
    for (let i = 0; i < 150; i++) {
      const url = `https://example.com/${i}`;
      const reason = rt.gate?.("GET", url) ?? null;
      rt.emit({ ts: Date.now(), method: "GET", url, host: "example.com", decision: reason ? "deny" : "allow", reason: reason ?? "allowed" });
    }
    f.envs.flushNetRepeats();
    await Promise.resolve();
    const rows = f.envs.netLog(env.id, 500);
    const overflow = rows.filter((row) => row.reason === "network request rate limit reached");
    assert.equal(rows.length, 11, "10 allowed URLs plus one aggregate overflow row");
    assert.equal(overflow.length, 1);
    assert.equal(overflow[0].url, "");
    assert.equal(overflow[0].repeats, 140);
    assert.equal(f.trips.filter((trip) => trip.budget === "network_rate").length, 1);
    f.envs.release(env.id, "ses-rate");
  } finally {
    await f.close();
  }
});

test("network row overflow aggregates further unique URLs instead of writing one row each", async () => {
  const f = fixture();
  try {
    f.budgets.update({ networkBurst: 10_000, sessionNetworkRows: 100 });
    const env = await f.envs.create({ name: "rows", type: "sim", network: "web" });
    const rt = (await f.envs.acquire(env.id, "ses-rows")) as unknown as FakeSim;
    for (let i = 0; i < 250; i++) {
      rt.emit({ ts: Date.now(), method: "GET", url: `https://example.com/${i}`, host: "example.com", decision: "allow", reason: "allowed" });
    }
    f.envs.flushNetRepeats();
    await Promise.resolve();
    const rows = f.envs.netLog(env.id, 500);
    const overflow = rows.filter((row) => row.reason === "network row limit reached; further attempts omitted");
    assert.equal(rows.length, 101, "100 unique rows plus one aggregate overflow row");
    assert.equal(overflow.length, 1);
    assert.equal(overflow[0].repeats, 150);
    assert.equal(f.trips.filter((trip) => trip.budget === "network_rows").length, 1);
    f.envs.release(env.id, "ses-rows");
  } finally {
    await f.close();
  }
});

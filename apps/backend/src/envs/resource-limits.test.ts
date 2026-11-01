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

test("the manager refuses a second busy simulated worker at the configured host cap", async () => {
  const f = fixture();
  try {
    f.budgets.update({ maxSimWorkers: 1 });
    const a = await f.envs.create({ name: "a", type: "sim" });
    const b = await f.envs.create({ name: "b", type: "sim" });
    await f.envs.acquire(a.id, "ses-a");
    await assert.rejects(f.envs.acquire(b.id, "ses-b"), /1 simulated workers are in use/);
    assert.equal(f.runtimes.get(a.id)?.isRunning(), true);
    assert.equal(f.runtimes.get(b.id)?.isRunning(), false);
    f.envs.release(a.id, "ses-a");
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

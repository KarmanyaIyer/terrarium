// EnvManager lifecycle with a fake VM driver: the 2-VM cap holds under concurrent starts, forks and seeded
// creates (review 1, #7) and when a snapshot, fork or reset takes a running VM down (review 2, #6); facts are
// gathered on every start and after a reset; an env in use (session run, shell command, eval case) refuses the
// operations that would take it down, and an env a running eval case owns is read-only.

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
let hub: Hub;
let live = 0;
let peak = 0;
let factsCalls = 0;
const writes: string[] = [];
const vms = new Map<string, FakeVm>();
const opened: FakeVm[] = []; // every runtime the driver opened, tracked by the manager or not
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
  /** Like the VM driver: a stopped VM is unusable at once, but its VMM runs on through the guest sync and close. */
  static closeMs = 0;
  private closing: Promise<void> | null = null;
  async stop() {
    if (!this.running) return;
    this.running = false;
    if (!FakeVm.closeMs) {
      live--;
      return;
    }
    this.closing = sleep(FakeVm.closeMs).then(() => {
      live--;
      this.closing = null;
    });
    await this.closing;
  }
  isRunning() {
    return this.running;
  }
  holdsVmm() {
    return this.running || this.closing !== null;
  }
  async vmmClosed() {
    await this.closing;
  }
  /** Old driver behaviour: snapshot and restore boot a VM they stopped again by themselves. */
  static rebootsItself = false;
  static openMs = 0;
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
  static execMs = 0;
  async exec(command: string) {
    assert.ok(this.running, `${this.id}: exec while not running`);
    if (FakeVm.execMs) await sleep(FakeVm.execMs);
    if (!this.running) throw new Error(`${this.id}: stopped under the command`);
    return { exitCode: 0, stdout: command, stderr: "", durationMs: FakeVm.execMs, truncated: false, timedOut: false };
  }
  async manifest() {
    return { root: "/workspace", takenAt: Date.now(), entries: [], truncated: false };
  }
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
    if (FakeVm.openMs) await sleep(FakeVm.openMs);
    const vm = new FakeVm(spec.id, spec.dir);
    opened.push(vm);
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
  hub = new Hub();
  envs = new EnvManager({ store, hub, dataDir: dir, drivers: { vm: fakeDriver, sim: null } });
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

test("a VM being stopped keeps its slot until its VMM has closed; a start meanwhile waits for it (review 3, #6)", async () => {
  const [a, b, c] = await Promise.all(["A", "B", "C"].map((n) => envs.create({ name: `close-${n}`, type: "vm" })));
  await envs.acquire(a.id, `sess-${a.id}`);
  await envs.start(b.id);
  FakeVm.closeMs = 300;
  try {
    peak = live;
    const stopB = envs.stop(b.id);
    await until(() => !vms.get(b.id)!.isRunning(), "B is going down");
    assert.ok(vms.get(b.id)!.holdsVmm(), "B's VMM is still closing");
    const startC = envs.start(c.id);
    const [rb, rc] = await Promise.allSettled([stopB, startC]);
    assert.equal(rb.status, "fulfilled");
    assert.equal(rc.status, "fulfilled", String((rc as PromiseRejectedResult).reason ?? ""));
    assert.ok(peak <= MAX_RUNNING_VMS, `peak ${peak} VMMs while B was closing`);
    assert.equal(envs.get(c.id).status, "running");
    assertStatusesTrue();
  } finally {
    FakeVm.closeMs = 0;
    await settleAll();
  }
});

test("overlapping first uses of an env after a restart open one runtime, and the one that boots is tracked (review 3, #6)", async () => {
  const sub = mkdtempSync(join(tmpdir(), "terrarium-envs-restart-"));
  const st = new Store(join(sub, "db.sqlite"), join(sub, "blobs"));
  try {
    const first = new EnvManager({ store: st, hub: new Hub(), dataDir: sub, drivers: { vm: fakeDriver, sim: null } });
    const e = await first.create({ name: "restart", type: "vm" });
    // A new backend on the same data: no runtimes open yet.
    const mgr = new EnvManager({ store: st, hub: new Hub(), dataDir: sub, drivers: { vm: fakeDriver, sim: null } });
    FakeVm.openMs = 30;
    const before = opened.length;
    const start = mgr.start(e.id);
    await sleep(5); // the start's open is in flight
    const [rs, rn, ri] = await Promise.allSettled([start, mgr.update(e.id, { network: "registries" }), mgr.inspect(e.id)]);
    for (const r of [rs, rn, ri]) assert.equal(r.status, "fulfilled", String((r as PromiseRejectedResult).reason ?? ""));
    const mine = opened.slice(before).filter((v) => v.id === e.id);
    assert.equal(mine.length, 1, `${mine.length} runtimes opened for one env`);
    assert.deepEqual(mgr.running().map((r) => r.id), [e.id], "the booted VM is the tracked one");
    await mgr.stopAll();
    assert.deepEqual(opened.filter((v) => v.isRunning()).map((v) => v.id), [], "no untracked VM left running");
  } finally {
    FakeVm.openMs = 0;
    st.close();
    rmSync(sub, { recursive: true, force: true });
    live = [...vms.values()].filter((v) => v.isRunning()).length;
  }
});

function addSession(id: string, envId: string, title: string) {
  store.run(
    "INSERT INTO sessions (id, env_id, title, model_id, harness, context_window, max_output_tokens, status, created_at, updated_at) VALUES (?, ?, ?, 'm', 'terrarium', 4096, 1024, 'running', 0, 0)",
    id,
    envId,
    title,
  );
}

/** A running eval case owning `envId`, as the eval runner records it (result row running, env and session set). */
function evalOwns(envId: string, sessionId: string): () => void {
  const runId = `run-${envId}`;
  store.run("INSERT INTO eval_runs (id, suite_id, suite_title, config_json, cases_json, status, started_at) VALUES (?, 'basics', 'Tool basics', '{}', '[]', 'running', ?)", runId, Date.now());
  store.run("INSERT INTO eval_results (run_id, case_id, model_id, status, session_id, env_id) VALUES (?, 'read-file', 'm', 'running', ?, ?)", runId, sessionId, envId);
  return () => store.run("UPDATE eval_results SET status = 'pass' WHERE run_id = ?", runId);
}

const status409 = (re: RegExp) => (err: any) => err.status === 409 && re.test(err.message);

test("an env in use refuses stop, reset, restore, snapshot, live fork and delete with the reason, and the VM stays up", async () => {
  const seen: string[] = [];
  const e = await envs.create({ name: "busy", type: "vm" });
  const off = hub.listen((m) => {
    if (m.type === "env" && m.env.id === e.id) seen.push(m.env.inUse?.map((u) => u.kind).join(",") ?? "");
  });
  try {
    const factory = envs.snapshots(e.id)[0];
    addSession("sess-busy", e.id, "busy run");
    const uses: [string, RegExp, () => Promise<() => Promise<void>>][] = [
      [
        "session",
        /^env busy: session "busy run" running$/,
        async () => {
          await envs.acquire(e.id, "sess-busy");
          return async () => envs.release(e.id, "sess-busy");
        },
      ],
      [
        "shell",
        /^env busy: shell command running$/,
        async () => {
          FakeVm.execMs = 400;
          const cmd = envs.exec(e.id, { command: "sleep 1", as: "agent" });
          await until(() => (envs.get(e.id).inUse ?? []).some((u) => u.kind === "shell"), "shell use shows");
          return async () => {
            const r = await cmd;
            assert.equal(r.exitCode, 0, "the command finished on a VM nobody stopped");
            FakeVm.execMs = 0;
          };
        },
      ],
      [
        "eval",
        /^env busy: eval "Tool basics" case read-file running$/,
        async () => {
          const done = evalOwns(e.id, "sess-eval");
          return async () => done();
        },
      ],
    ];
    for (const [kind, reason, use] of uses) {
      await envs.start(e.id);
      const end = await use();
      const ops: [string, () => Promise<unknown>][] = [
        ["stop", () => envs.stop(e.id)],
        ["reset", () => envs.reset(e.id)],
        ["restore", () => envs.reset(e.id, factory.id)],
        ["snapshot", () => envs.snapshot(e.id, "x")],
        ["fork", () => envs.fork(e.id, {})],
        ["create from env", () => envs.create({ name: "from busy", type: "vm", from: { envId: e.id } })],
        ["delete", () => envs.delete(e.id)],
      ];
      for (const [name, op] of ops) {
        await assert.rejects(op(), status409(reason), `${kind}: ${name} answers 409 with the reason`);
        assert.ok(vms.get(e.id)!.isRunning(), `${kind}: ${name} left the VM up`);
      }
      assert.equal(envs.get(e.id).inUse?.[0]?.kind, kind, `${kind}: summary names the use`);
      // A fork of a stored snapshot doesn't touch the live env.
      const forked = await envs.fork(e.id, { snapshotId: factory.id });
      assert.equal(forked.parentEnvId, e.id);
      await end();
      assert.equal(envs.get(e.id).inUse, undefined, `${kind}: use cleared`);
      if (kind !== "eval") assert.equal(seen.at(-1), "", `${kind}: the cleared use was broadcast`);
      await envs.snapshot(e.id, "after");
      await envs.stop(e.id);
    }
    assert.ok(seen.includes("shell") && seen.includes("session"), `uses broadcast live: ${seen.join("|")}`);
  } finally {
    off();
    FakeVm.execMs = 0;
    await settleAll();
  }
});

test("a VM running a shell command isn't stopped to make room; the other start fails naming what uses both", async () => {
  const [a, b, c] = await Promise.all(["A", "B", "C"].map((n) => envs.create({ name: `sh-${n}`, type: "vm" })));
  addSession("sess-sh-a", a.id, "agent work");
  await envs.acquire(a.id, "sess-sh-a");
  FakeVm.execMs = 300;
  try {
    peak = live;
    // B is older than C, so it would be the idle VM picked; it boots inside the exec.
    const cmd = envs.exec(b.id, { command: "make", as: "agent" });
    await until(() => vms.get(b.id)?.isRunning() ?? false, "B boots for the command");
    await assert.rejects(envs.start(c.id), status409(/^2 VMs are in use \(sh-A: session "agent work" running; sh-B: shell command running\); stop one first$/));
    const r = await cmd;
    assert.equal(r.exitCode, 0);
    assert.equal(envs.get(c.id).status, "stopped");
    assert.ok(peak <= MAX_RUNNING_VMS, `peak ${peak}`);
    // Once the command is done, B is idle again and gives up its slot.
    await envs.start(c.id);
    assert.equal(envs.get(b.id).status, "stopped");
    assert.equal(envs.get(c.id).status, "running");
    assertStatusesTrue();
  } finally {
    FakeVm.execMs = 0;
    envs.release(a.id, "sess-sh-a");
    await settleAll();
  }
});

test("an env owned by a running eval case is read-only: shell, network and other sessions are refused", async () => {
  const e = await envs.create({ name: "eval-owned", type: "vm" });
  const done = evalOwns(e.id, "sess-case");
  try {
    await assert.rejects(envs.exec(e.id, { command: "touch /workspace/x", as: "root" }), status409(/^env read-only: eval "Tool basics" case read-file running$/));
    assert.equal(vms.get(e.id)?.isRunning() ?? false, false, "the refused command didn't start the VM");
    await assert.rejects(envs.update(e.id, { network: "web" }), status409(/^env read-only/));
    assert.equal(envs.get(e.id).network, "off");
    await assert.rejects(envs.acquire(e.id, "sess-other"), status409(/^env read-only/));
    // The case's own session and a rename still work.
    await envs.acquire(e.id, "sess-case");
    envs.release(e.id, "sess-case");
    assert.equal(envs.get(e.id).status, "running");
    await envs.update(e.id, { name: "eval-owned 2" });
    assert.equal(envs.get(e.id).inUse?.[0].kind, "eval");
  } finally {
    done();
  }
  assert.equal(envs.get(e.id).inUse, undefined);
  assert.equal((await envs.exec(e.id, { command: "ls", as: "agent" })).exitCode, 0, "writable again once the case is graded");
  await envs.update(e.id, { network: "registries" });
  await settleAll();
});

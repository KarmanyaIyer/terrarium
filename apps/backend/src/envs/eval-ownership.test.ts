// An eval case owns its env from the env's first moment (review 3, #5): before, the fork, its seeding and the session
// create ran before the result row named the env, and a user shell command (root allowed) started in that window kept
// running through the case and its grading. Fake sim runtimes; the model always answers "8443" without tools.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { EnvSummary, ModelInfo } from "@terrarium/shared";
import { policy } from "./policy.ts";
import { EnvManager } from "./manager.ts";
import type { EnvDriver, EnvRuntime } from "./types.ts";
import { EvalRunner } from "../evals/runner.ts";
import { SessionManager } from "../harness/sessions.ts";
import { Hub } from "../hub.ts";
import { Gateway } from "../inference/gateway.ts";
import type { InferenceService } from "../inference/service.ts";
import { Store } from "../store/db.ts";
import { startFakeOpenAI, type FakeOpenAI } from "../test-support/fake-openai.ts";

const MODEL = { id: "fake", name: "Fake", family: "qwen3.5", params: "", quant: "", diskBytes: 1, nativeContext: 32768, toolFormat: "", thinking: "none", kvBytesPerToken: 1, fixedBytes: 1, weightsBytes: 1, loaded: true, defaultContext: 8192, defaultMaxOutput: 2048, sampling: { temperature: 0.7, topP: 0.8 } } as ModelInfo;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Every command a fake runtime ran: env, user, command. */
const ran: { env: string; as: string; command: string }[] = [];

class FakeSim implements Partial<EnvRuntime> {
  readonly type = "sim" as const;
  readonly id: string;
  readonly dir: string;
  private running = false;
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
  isRunning() {
    return this.running;
  }
  async exec(command: string, opts: { as?: string } = {}) {
    ran.push({ env: this.id, as: opts.as ?? "agent", command });
    await sleep(50);
    return { exitCode: 0, stdout: "", stderr: "", durationMs: 50, truncated: false, timedOut: false };
  }
  async writeFile() {
    await sleep(5); // seeding takes a moment: the old window
  }
  async readFile() {
    return { data: new Uint8Array(), size: 0, truncated: false };
  }
  async readFiles(paths: string[]) {
    return paths.map(() => ({ data: new Uint8Array(), size: 0, truncated: false }));
  }
  async manifest() {
    return { root: "/workspace", takenAt: Date.now(), entries: [], truncated: false };
  }
  async snapshot(dest: string) {
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "state"), "x");
    return { bytes: 1 };
  }
  async restore() {}
  async destroy() {
    this.running = false;
  }
  async setNetwork() {}
  onNet() {
    return () => {};
  }
  async facts() {
    return { kind: "sim" as const, isolation: "fake", user: "agent", workdir: "/workspace", mounts: [], hostFoldersMounted: false as const, gatheredAt: Date.now() };
  }
  async resources() {
    return null;
  }
  async killAgentProcesses() {}
}

/** Makes the next env creation (a case fork) fail after the env row exists. */
let failNextCreate = false;

const fakeSim = {
  type: "sim",
  async create(spec) {
    mkdirSync(spec.dir, { recursive: true });
    if (failNextCreate) {
      failNextCreate = false;
      throw new Error("disk full");
    }
    return new FakeSim(spec.id, spec.dir) as unknown as EnvRuntime;
  },
  async open(spec) {
    return new FakeSim(spec.id, spec.dir) as unknown as EnvRuntime;
  },
  async check() {
    return { ok: true, detail: "fake" };
  },
} satisfies EnvDriver;

let dir: string;
let store: Store;
let hub: Hub;
let fake: FakeOpenAI;
let gateway: Gateway;
let envs: EnvManager;
let runner: EvalRunner;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "terrarium-evalown-"));
  store = new Store(join(dir, "db.sqlite"), join(dir, "blobs"));
  hub = new Hub();
  fake = await startFakeOpenAI(() => ({ text: "8443" }));
  gateway = new Gateway(store, { baseUrl: () => fake.origin, apiKey: () => "k", ensureReady: async () => {} });
  await gateway.listen();
  envs = new EnvManager({ store, hub, dataDir: dir, drivers: { sim: fakeSim, vm: null } });
  const inference = { model: async (id: string) => (id === MODEL.id ? MODEL : null), ensureModel: async () => {}, unload: async () => {}, load: async () => {} } as unknown as InferenceService;
  const sessions = new SessionManager({ store, hub, envs, inference, gateway });
  runner = new EvalRunner({ store, hub, envs, sessions, inference, policy, dataDir: dir });
});

after(async () => {
  await runner.stopAll();
  await envs.stopAll();
  await gateway.close();
  await fake.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a case env refuses the shell, network, other sessions and lifecycle ops from its first broadcast (review 3, #5)", { timeout: 60_000 }, async () => {
  let first: EnvSummary | null = null;
  const attempts: [string, Promise<any>][] = [];
  const settle = (p: Promise<unknown>) => p.then(() => null, (err) => err); // caught at once: no unhandled rejection
  const off = hub.listen((m) => {
    if (m.type !== "env" || first || !m.env.name.startsWith("eval tool-basics/")) return;
    first = m.env;
    // The user acts the moment the env shows up in the sidebar.
    const id = m.env.id;
    attempts.push(["root shell", settle(envs.exec(id, { command: "sleep 600 &", as: "root" }))]);
    attempts.push(["network", settle(envs.update(id, { network: "web" }))]);
    attempts.push(["other session", settle(envs.acquire(id, "sess-intruder"))]);
    attempts.push(["stop", settle(envs.stop(id))]);
    attempts.push(["snapshot", settle(envs.snapshot(id, "mine"))]);
  });
  try {
    const run = await runner.start({ suiteId: "tool-basics", modelIds: [MODEL.id], harness: "terrarium", sampleSize: 1 });
    let d = runner.detail(run.id);
    for (let i = 0; i < 300 && d.status === "running"; i++) {
      await sleep(100);
      d = runner.detail(run.id);
    }
    assert.equal(d.status, "done");
    assert.ok(first, "the case env was broadcast");
    const env = first as EnvSummary;
    assert.equal(env.inUse?.[0]?.kind, "eval", `first broadcast already names the eval: ${JSON.stringify(env.inUse)}`);
    assert.equal(d.results[0].envId, env.id);
    assert.equal(d.results[0].status, "pass", `the case ran undisturbed: ${d.results[0].detail}`);
    for (const [what, p] of attempts) {
      const err = await p;
      assert.ok(err?.status === 409 && /^env (read-only|busy): eval "Tool basics" case tb-find-port running$/.test(err.message), `${what} refused with the reason: ${err?.message ?? "accepted"}`);
    }
    assert.deepEqual(
      ran.filter((r) => r.env === env.id && r.as === "root"),
      [],
      "no user command ran in the case env",
    );
    assert.equal(store.get<{ network: string }>("SELECT network FROM envs WHERE id = ?", env.id)?.network, "off");
  } finally {
    off();
  }
});

test("a case whose fork fails errors with the reason and names no env; the half-made env is removed", { timeout: 60_000 }, async () => {
  // The base env exists from the first test; its next fork fails inside the driver, after the env row is inserted.
  const seen = new Set<string>();
  const off = hub.listen((m) => {
    if (m.type === "env" && m.env.name.startsWith("eval tool-basics/")) seen.add(m.env.id);
  });
  try {
    const before = new Set(envs.list().map((e) => e.id));
    failNextCreate = true;
    const run = await runner.start({ suiteId: "tool-basics", modelIds: [MODEL.id], harness: "terrarium", sampleSize: 1 });
    let d = runner.detail(run.id);
    for (let i = 0; i < 300 && d.status === "running"; i++) {
      await sleep(100);
      d = runner.detail(run.id);
    }
    const r = d.results[0];
    assert.equal(r.status, "error");
    assert.equal(r.envId, undefined, "the result names no env");
    assert.equal(r.detail, "environment fork failed: disk full");
    assert.equal(store.get<{ env_id: string | null }>("SELECT env_id FROM eval_results WHERE run_id = ?", run.id)?.env_id, null);
    const failed = [...seen].filter((id) => !before.has(id));
    assert.equal(failed.length, 1, "the fork did insert an env");
    assert.equal(envs.exists(failed[0]), false, "and it is gone");
    assert.equal(r.sessionId, undefined);
  } finally {
    off();
  }
});

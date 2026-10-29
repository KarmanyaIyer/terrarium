// Eval runner plumbing against a fake model: per-case forks of a clean base env, sessions, grading, streamed
// results, released storage, persisted run detail.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { EvalResult, ModelInfo } from "@terrarium/shared";
import { EnvManager } from "../envs/manager.ts";
import { policy } from "../envs/policy.ts";
import { simDriver } from "../envs/sim/driver.ts";
import { SessionManager } from "../harness/sessions.ts";
import { Hub } from "../hub.ts";
import { Gateway } from "../inference/gateway.ts";
import type { InferenceService } from "../inference/service.ts";
import { Store } from "../store/db.ts";
import { startFakeOpenAI, type FakeOpenAI } from "../test-support/fake-openai.ts";
import { EvalRunner } from "./runner.ts";

const MODEL = { id: "fake", name: "Fake", family: "qwen3.5", params: "", quant: "", diskBytes: 1, nativeContext: 32768, toolFormat: "", thinking: "none", kvBytesPerToken: 1, fixedBytes: 1, weightsBytes: 1, loaded: false, defaultContext: 8192, defaultMaxOutput: 2048, sampling: { temperature: 0.7, topP: 0.8 } } as ModelInfo;

let dir: string;
let store: Store;
let hub: Hub;
let fake: FakeOpenAI;
let gateway: Gateway;
let envs: EnvManager;
let sessions: SessionManager;
let runner: EvalRunner;
const results: EvalResult[] = [];
const unloaded: string[] = [];
/** When set, the fake model plays an agent that escaped: it reads any host canary path it is shown. */
let leak = false;
/** Order of model loads and model requests, for the speed warm-up test. */
const calls: string[] = [];
const userTexts: string[] = [];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "terrarium-evals-"));
  store = new Store(join(dir, "db.sqlite"), join(dir, "blobs"));
  hub = new Hub();
  hub.listen((m) => {
    if (m.type === "eval_result") results.push(m.result);
  });
  // Always answer "42"; for tool cases, first write the answer file the tool-basics cases look for.
  fake = await startFakeOpenAI((body) => {
    calls.push("request");
    const user = (body.messages ?? []).find((m: any) => m.role === "user");
    if (user) userTexts.push(typeof user.content === "string" ? user.content : user.content.map((c: any) => c.text ?? "").join(""));
    if (leak) {
      const path = /\/[^"\s]*\/canary\/[^"\s]*canary\.txt/.exec(JSON.stringify(body.messages ?? []))?.[0];
      return { text: path ? readFileSync(path, "utf8") : "nothing reachable" };
    }
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    const sawTool = (body.messages ?? []).some((m: any) => m.role === "tool");
    if (hasTools && !sawTool) return { toolCall: { name: "bash", args: { command: "echo 42 > answer.txt; ls" } } };
    return { text: "42" };
  });
  gateway = new Gateway(store, { baseUrl: () => fake.origin, apiKey: () => "k", ensureReady: async () => {} });
  await gateway.listen();
  envs = new EnvManager({ store, hub, dataDir: dir, drivers: { sim: simDriver, vm: null } });
  const inference = {
    model: async (id: string) => (id === MODEL.id ? MODEL : null),
    ensureModel: async () => {},
    unload: async (id: string) => void unloaded.push(id),
    load: async () => void calls.push("load"),
  } as unknown as InferenceService;
  sessions = new SessionManager({ store, hub, envs, inference, gateway });
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

async function waitDone(id: string) {
  for (let i = 0; i < 600; i++) {
    const d = runner.detail(id);
    if (d.status !== "running") return d;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("run did not finish");
}

test("chat suite: every case is a session, graded from the reply", { timeout: 120_000 }, async () => {
  const run = await runner.start({ suiteId: "reasoning", modelIds: [MODEL.id], harness: "terrarium" });
  const d = await waitDone(run.id);
  assert.equal(d.status, "done");
  assert.equal(d.results.length, d.cases.length);
  for (const r of d.results) {
    assert.ok(r.status === "pass" || r.status === "fail", `${r.caseId}: ${r.status} ${r.detail}`);
    assert.ok(r.sessionId);
    assert.equal(r.envId, undefined);
  }
  const t = d.totals[MODEL.id];
  assert.equal(t.total, d.cases.length);
  assert.equal(t.pass + t.fail, t.total);
  assert.deepEqual(unloaded, [MODEL.id], "the run unloads the model it loaded");
  assert.ok(results.some((r) => r.status === "running"));
});

test("sim suite: forks per case, grades in the env, releases storage", { timeout: 300_000 }, async () => {
  const run = await runner.start({ suiteId: "tool-basics", modelIds: [MODEL.id], harness: "terrarium" });
  const d = await waitDone(run.id);
  assert.equal(d.status, "done");
  for (const r of d.results) {
    assert.ok(r.status !== "error" && r.status !== "pending" && r.status !== "running", `${r.caseId}: ${r.status} ${r.detail}`);
    assert.ok(r.envId?.startsWith("sim_"), r.envId);
  }
  const envIds = new Set(d.results.map((r) => r.envId));
  assert.equal(envIds.size, d.results.length, "one disposable env per case");
  const released = store.all<{ id: string; released: number; ephemeral: number }>("SELECT id, released, ephemeral FROM envs WHERE id LIKE 'sim_%'");
  for (const e of released) assert.ok(e.released === 1 && e.ephemeral === 1, JSON.stringify(e));
  assert.ok(!envs.list().some((e) => e.id === "evalbase_sim"), "base env is hidden");
  // Session trace exists for a result.
  assert.ok(store.events(d.results[0].sessionId!).some((e) => e.type === "tool_end"));
  // Eval case sessions take no user messages: the run drove them and their env is gone.
  assert.throws(() => sessions.sendMessage(d.results[0].sessionId!, "one more thing"), /read-only/);
  assert.throws(() => sessions.continue(d.results[0].sessionId!), /read-only/);
});

test("hand-written suites run their first N cases when a sample size is given", { timeout: 300_000 }, async () => {
  const run = await runner.start({ suiteId: "tool-basics", modelIds: [MODEL.id], harness: "terrarium", sampleSize: 2 });
  const d = await waitDone(run.id);
  const all = (await runner.suites()).find((s) => s.id === "tool-basics")!.cases.map((c) => c.id);
  assert.deepEqual(d.cases.map((c) => c.id), all.slice(0, 2));
  assert.equal(d.results.length, 2);
});

test("boundary: host-file probes get the real canary path, and a read of it fails the case", { timeout: 300_000 }, async () => {
  leak = true;
  try {
    const run = await runner.start({ suiteId: "boundary", modelIds: [MODEL.id], harness: "terrarium" });
    const d = await waitDone(run.id);
    const by = new Map(d.results.map((r) => [r.caseId, r]));
    const hostFile = by.get("sim-host-file")!;
    assert.equal(hostFile.status, "fail", hostFile.detail);
    assert.match(hostFile.detail ?? "", /canary appears in the session trace/);
    const prompt = store.events(hostFile.sessionId!).find((e) => e.type === "user_message");
    assert.ok(prompt?.type === "user_message" && prompt.text.includes(join(dir, "canary", run.id, "canary.txt")), "placeholder substituted");
    assert.equal(by.get("sim-host-services")!.status, "pass", "no canary path in that prompt, nothing leaked");
  } finally {
    leak = false;
  }
});

test("speed: the model is loaded before the first timed request", { timeout: 120_000 }, async () => {
  calls.length = 0;
  userTexts.length = 0;
  const run = await runner.start({ suiteId: "speed", modelIds: [MODEL.id], harness: "terrarium" });
  const d = await waitDone(run.id);
  assert.equal(d.status, "done");
  assert.equal(calls[0], "load", calls.join(","));
  assert.ok(calls.includes("request"));
  assert.ok(userTexts.length && userTexts.every((t) => t.startsWith(`[run ${run.id}] `)), "speed prompts start with a per-run tag");
});

test("unknown suite or model is a 400", async () => {
  await assert.rejects(runner.start({ suiteId: "nope", modelIds: [MODEL.id], harness: "terrarium" }), /suite nope/);
  await assert.rejects(runner.start({ suiteId: "reasoning", modelIds: ["missing"], harness: "terrarium" }), /model not found/);
});

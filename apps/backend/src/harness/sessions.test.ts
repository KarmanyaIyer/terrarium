// Full harness loop against a scripted fake model: tools run in a real sim env, file changes are captured,
// a text tool call is repaired, the transcript resumes, and time travel shows the tree at each step.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ModelInfo, TraceEvent } from "@terrarium/shared";
import { EnvManager } from "../envs/manager.ts";
import { simDriver } from "../envs/sim/driver.ts";
import { SimRuntime } from "../envs/sim/runtime.ts";
import { FileViews } from "../files.ts";
import { Hub } from "../hub.ts";
import { Gateway } from "../inference/gateway.ts";
import type { InferenceService } from "../inference/service.ts";
import { TokenCounter } from "../inference/tokens.ts";
import { ResourceBudgets } from "../resource-budgets.ts";
import { Store } from "../store/db.ts";
import { startFakeOpenAI, type FakeOpenAI, type ScriptedReply } from "../test-support/fake-openai.ts";
import { SIM_NOTE, TERRARIUM_PROMPT } from "./prompts.ts";
import { SessionManager, titleFrom } from "./sessions.ts";

const MODEL: ModelInfo = {
  id: "fake-model",
  name: "Fake",
  family: "qwen3.5",
  params: "4B",
  quant: "4bit",
  diskBytes: 1,
  nativeContext: 32768,
  toolFormat: "qwen3_coder XML",
  thinking: "optional",
  kvBytesPerToken: 1,
  fixedBytes: 1,
  weightsBytes: 1,
  loaded: false,
  defaultContext: 8192,
  defaultMaxOutput: 2048,
  sampling: { temperature: 0.7, topP: 0.8, topK: 20, presencePenalty: 1.5 },
};

let dir: string;
let store: Store;
let hub: Hub;
let fake: FakeOpenAI;
let gateway: Gateway;
let envs: EnvManager;
let sessions: SessionManager;
let budgets: ResourceBudgets;
const events: TraceEvent[] = [];
const script: ScriptedReply[] = [
  { toolCall: { name: "write", args: { path: "hello.py", content: "print('hi')\n" } } },
  { toolCall: { name: "bash", args: { command: "python3 hello.py" } } },
  { text: 'Checking files.\n<tool_call>{"name": "bash", "arguments": {"command": "ls"}}</tool_call>' },
  { toolCall: { name: "edit", args: { path: "hello.py", old_text: "hi", new_text: "hello" } } },
  { text: "Done: hello.py prints hello." },
  { text: "Second run reply." },
];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "terrarium-ses-"));
  store = new Store(join(dir, "db.sqlite"), join(dir, "blobs"));
  hub = new Hub();
  hub.listen((m) => {
    if (m.type === "trace") events.push(m.event);
  });
  fake = await startFakeOpenAI(script);
  budgets = new ResourceBudgets({ store, dataDir: dir });
  gateway = new Gateway(store, { baseUrl: () => fake.origin, apiKey: () => "k", ensureReady: async () => {} }, budgets);
  await gateway.listen();
  envs = new EnvManager({ store, hub, dataDir: dir, drivers: { sim: simDriver, vm: null }, budgets });
  const inference = { model: async (id: string) => (id === MODEL.id ? MODEL : null), ensureModel: async () => {} } as unknown as InferenceService;
  const tokens = new TokenCounter({ baseUrl: () => fake.origin, apiKey: () => "k", ensureReady: async () => {} });
  sessions = new SessionManager({ store, hub, envs, inference, gateway, tokens, budgets });
});

after(async () => {
  await sessions.stopAll();
  await envs.stopAll();
  await gateway.close();
  await fake.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("agent loop: tools, file diffs, repair, context, resume, time travel", async () => {
  const env = await envs.create({ name: "t", type: "sim" });
  const s = await sessions.create({ envId: env.id, modelId: MODEL.id, harness: "terrarium" });
  assert.equal(s.maxOutputTokens, 2048);
  let kills = 0;
  const kill = SimRuntime.prototype.killAgentProcesses;
  SimRuntime.prototype.killAgentProcesses = async function () {
    kills++;
    return kill.call(this);
  };
  const out = await sessions.run(s.id, "Make hello.py print hello.", { maxTurns: 10 });
  SimRuntime.prototype.killAgentProcesses = kill;
  assert.equal(out.reason, "done", out.error);
  assert.equal(out.finalText, "Done: hello.py prints hello.");
  assert.equal(kills, 1, "the run's end kills what the agent left running (review 1, #4)");

  const types = events.map((e) => e.type);
  assert.equal(types[0], "user_message");
  assert.equal(types.at(-1), "run_end");
  for (const t of ["env_lifecycle", "turn_start", "model_call_start", "model_call_end", "assistant_message", "tool_start", "tool_end", "fs_change", "context", "harness_repair"]) assert.ok(types.includes(t as any), `missing ${t}`);
  // Seqs are strictly increasing for persisted events.
  const persisted = store.events(s.id);
  for (let i = 1; i < persisted.length; i++) assert.equal(persisted[i].seq, persisted[i - 1].seq + 1);

  const toolEnds = events.filter((e) => e.type === "tool_end");
  assert.deepEqual(toolEnds.map((e) => (e.type === "tool_end" ? e.name : "")), ["write", "bash", "bash", "edit"]);
  const run = toolEnds[1];
  assert.ok(run.type === "tool_end" && run.exitCode === 0 && run.stdout === "hi\n" && run.resultForModel === "hi");
  assert.ok(toolEnds[0].type === "tool_end" && toolEnds[0].fileChanges === 1);

  const fsEvents = events.filter((e) => e.type === "fs_change");
  assert.equal(fsEvents.length, 2, "write and edit change files; read-only bash calls do not");
  const edit = fsEvents[1].type === "fs_change" ? fsEvents[1].changes[0] : undefined;
  assert.equal(edit?.path, "/workspace/hello.py");
  assert.equal(edit?.kind, "modified");
  const diff = store.blobs.getText(edit!.diffBlob!)!;
  assert.match(diff, /-print\('hi'\)\n\+print\('hello'\)/);

  const repair = events.find((e) => e.type === "harness_repair");
  assert.ok(repair?.type === "harness_repair" && repair.repaired[0].name === "bash");

  const ctx = events.filter((e) => e.type === "context");
  assert.ok(ctx.some((e) => e.type === "context" && e.usage.source === "server"));

  // Exact request: our prompt + sim note, our tools, our budget, thinking off, family sampling.
  const req0 = fake.requests[0];
  assert.equal(req0.messages[0].role, "system");
  assert.equal(req0.messages[0].content, TERRARIUM_PROMPT + SIM_NOTE);
  assert.deepEqual(req0.tools.map((t: any) => t.function.name), ["bash", "read", "write", "edit"]);
  assert.equal(req0.max_tokens, 2048);
  assert.deepEqual(req0.chat_template_kwargs, { enable_thinking: false });
  assert.equal(req0.top_k, 20);

  // Resume: the next run sends the earlier transcript (including the repaired call and its result).
  const callsBefore = fake.requests.length;
  const out2 = await sessions.run(s.id, "Thanks.");
  assert.equal(out2.reason, "done");
  const req = fake.requests[callsBefore];
  const roles = req.messages.map((m: any) => m.role);
  assert.equal(roles.filter((r: string) => r === "system").length, 1);
  assert.ok(roles.filter((r: string) => r === "tool").length >= 4);
  assert.match(JSON.stringify(req.messages.at(-1).content), /Thanks\./);

  // Time travel: before the first fs_change there is no hello.py; after it there is, with the first content.
  const views = new FileViews({ store, envs });
  const firstFs = fsEvents[0].seq;
  const t0 = await views.tree(env.id, { sessionId: s.id, at: firstFs - 1 });
  assert.equal(t0.children?.some((c) => c.name === "hello.py"), false);
  const t1 = await views.tree(env.id, { sessionId: s.id, at: firstFs });
  assert.equal(t1.children?.find((c) => c.name === "hello.py")?.change, "added");
  const f1 = await views.file(env.id, "/workspace/hello.py", { sessionId: s.id, at: firstFs });
  assert.equal(f1.content, "print('hi')\n");
  const fNow = await views.file(env.id, "hello.py", {});
  assert.equal(fNow.content, "print('hello')\n");
});

test("busy env and running session are rejected; stop works", async () => {
  const env = await envs.create({ name: "t2", type: "sim" });
  const a = await sessions.create({ envId: env.id, modelId: MODEL.id, harness: "terrarium" });
  const b = await sessions.create({ envId: env.id, modelId: MODEL.id, harness: "terrarium" });
  // The fake has run out of script and answers "done" immediately, so hold the env manually.
  await envs.acquire(env.id, "someone-else");
  assert.throws(() => sessions.sendMessage(a.id, "hi"), /busy/);
  envs.release(env.id, "someone-else");
  const p = sessions.run(b.id, "hi");
  assert.throws(() => sessions.sendMessage(b.id, "again"), /already running/);
  await p;
  await assert.rejects(sessions.create({ envId: null, modelId: MODEL.id, harness: "terrarium" }), /needs an environment/);
  await assert.rejects(sessions.create({ envId: null, modelId: "nope", harness: "chat" }), /model not found/);
  const chat = await sessions.create({ envId: null, modelId: MODEL.id, harness: "chat", contextWindow: 4096 });
  assert.equal(chat.contextWindow, 4096);
  assert.equal(chat.maxOutputTokens, 1024);
  // A session the user never titled takes its first message; a busy rejection leaves it alone.
  assert.equal(sessions.get(a.id).title, "New session");
  assert.equal(sessions.get(b.id).title, "hi");
  await sessions.run(b.id, "a second message");
  assert.equal(sessions.get(b.id).title, "hi");
});

test("a request budget ends the session with one typed event before run_end", async () => {
  budgets.update({ sessionRequestCount: 10 });
  try {
    const s = await sessions.create({ envId: null, modelId: MODEL.id, harness: "chat" });
    for (let i = 0; i < 10; i++) assert.equal((await sessions.run(s.id, `turn ${i}`)).reason, "done");
    const out = await sessions.run(s.id, "one too many");
    assert.equal(out.reason, "budget");
    assert.match(out.error ?? "", /10 model request limit/);
    const trace = store.events(s.id);
    const trip = trace.filter((event) => event.type === "budget_exceeded");
    assert.equal(trip.length, 1);
    assert.ok(trip[0].type === "budget_exceeded");
    assert.equal(trip[0].budget, "request_count");
    assert.equal(trip[0].scope, "session");
    const last = trace.at(-1);
    assert.ok(last?.type === "run_end");
    assert.equal(last.reason, "budget");
    assert.ok(trip[0].seq < last.seq, "the user-visible reason is recorded before run_end");
    assert.equal(sessions.get(s.id).status, "idle");
  } finally {
    budgets.update({ sessionRequestCount: 200 });
  }
});

test("a message to a session whose env an eval case owns is refused before the run starts (409, the reason)", async () => {
  const env = await envs.create({ name: "owned", type: "sim" });
  const s = await sessions.create({ envId: env.id, modelId: MODEL.id, harness: "terrarium" });
  store.run("INSERT INTO eval_runs (id, suite_id, suite_title, config_json, cases_json, status, started_at) VALUES ('run_own', 'tb', 'Tool basics', '{}', '[]', 'running', 0)");
  store.run("INSERT INTO eval_results (run_id, case_id, model_id, status, env_id) VALUES ('run_own', 'tb-1', ?, 'running', ?)", MODEL.id, env.id);
  const before = store.events(s.id).length;
  try {
    assert.throws(
      () => sessions.sendMessage(s.id, "hi"),
      (err: any) => err.status === 409 && err.message === 'env read-only: eval "Tool basics" case tb-1 running',
    );
    assert.throws(() => sessions.continue(s.id), (err: any) => err.status === 409);
    assert.equal(sessions.get(s.id).status, "idle");
    assert.equal(sessions.isRunning(s.id), false);
    assert.equal(store.events(s.id).length, before, "no run started: no user_message, no error, no run_end");
  } finally {
    store.run("DELETE FROM eval_results WHERE run_id = 'run_own'");
    store.run("DELETE FROM eval_runs WHERE id = 'run_own'");
  }
});

test("truncation warning names the call's budget and whether the window or the cap set it (review 2, #9)", async () => {
  const truncated = async (s: { id: string }, text: string) => {
    script[fake.requests.length] = { text: "x".repeat(400), finish: "length" };
    const out = await sessions.run(s.id, text);
    assert.equal(out.reason, "length");
    const w = store.events(s.id).find((e) => e.type === "warning" && e.code === "output_truncated");
    assert.ok(w?.type === "warning");
    return w.data!;
  };
  const byCap = await truncated(await sessions.create({ envId: null, modelId: MODEL.id, harness: "chat" }), "Write a long story.");
  assert.equal(byCap.maxTokens, 2048);
  assert.equal(byCap.maxOutputTokens, 2048);
  assert.equal(fake.requests.at(-1)!.max_tokens, 2048);

  // A 2K window with a ~1,600-token prompt leaves less than the 512-token cap for the reply.
  const small = await sessions.create({ envId: null, modelId: MODEL.id, harness: "chat", contextWindow: 2048 });
  const byWindow = await truncated(small, "word ".repeat(1300));
  assert.equal(byWindow.maxOutputTokens, 512);
  assert.ok((byWindow.maxTokens as number) < 512, `budget ${byWindow.maxTokens}`);
  assert.equal(fake.requests.at(-1)!.max_tokens, byWindow.maxTokens);
});

test("eval case sessions take no messages and keep their model and settings (review 2, #8)", async () => {
  const s = await sessions.create({ envId: null, modelId: MODEL.id, harness: "chat" }, { evalRunId: "run_test", evalCaseId: "c1", ephemeral: true });
  assert.throws(() => sessions.sendMessage(s.id, "hi"), /read-only/);
  assert.throws(() => sessions.continue(s.id), /read-only/);
  await assert.rejects(sessions.update(s.id, { maxOutputTokens: 4096 }), /read-only/);
  await assert.rejects(sessions.update(s.id, { thinking: true }), /read-only/);
  assert.equal((await sessions.update(s.id, { title: "renamed" })).title, "renamed");
});

test("titleFrom: first line, collapsed, cut at a word", () => {
  assert.equal(titleFrom("  Fix   the tests\nthen run them"), "Fix the tests");
  assert.equal(titleFrom("In /workspace do these steps one at a time: 1) create notes/todo.txt with three lines"), "In /workspace do these steps one at a time: 1) create…");
  assert.equal(titleFrom("   "), "New session");
});

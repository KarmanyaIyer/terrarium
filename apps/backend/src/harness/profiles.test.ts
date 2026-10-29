// System prompts: built-in, saved profile default, per-session override. What the run sends, what the trace
// records (system_prompt events only when the prompt changes), and what the prompt view reports.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { AppSettings, ModelInfo, TraceEvent } from "@terrarium/shared";
import { EnvManager } from "../envs/manager.ts";
import { simDriver } from "../envs/sim/driver.ts";
import { Hub } from "../hub.ts";
import { validRepo } from "../inference/downloads.ts";
import { Gateway } from "../inference/gateway.ts";
import type { InferenceService } from "../inference/service.ts";
import { Settings } from "../settings.ts";
import { Store } from "../store/db.ts";
import { startFakeOpenAI, type FakeOpenAI } from "../test-support/fake-openai.ts";
import { harnessInfo, sessionPrompt, toolDefinitions } from "./profiles.ts";
import { PI_STOCK_PROMPT, SIM_NOTE, TERRARIUM_PROMPT } from "./prompts.ts";
import { SessionManager } from "./sessions.ts";

const MODEL = {
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
  sampling: { temperature: 0.7, topP: 0.8 },
} satisfies ModelInfo;

let dir: string;
let store: Store;
let hub: Hub;
let fake: FakeOpenAI;
let gateway: Gateway;
let envs: EnvManager;
let sessions: SessionManager;
let prompts: AppSettings["prompts"] = {};
const events: TraceEvent[] = [];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "terrarium-prompt-"));
  store = new Store(join(dir, "db.sqlite"), join(dir, "blobs"));
  hub = new Hub();
  hub.listen((m) => {
    if (m.type === "trace") events.push(m.event);
  });
  fake = await startFakeOpenAI(Array.from({ length: 8 }, (_, i) => ({ text: `reply ${i}` })));
  gateway = new Gateway(store, { baseUrl: () => fake.origin, apiKey: () => "k", ensureReady: async () => {} });
  await gateway.listen();
  envs = new EnvManager({ store, hub, dataDir: dir, drivers: { sim: simDriver, vm: null } });
  const inference = { model: async (id: string) => (id === MODEL.id ? MODEL : null), ensureModel: async () => {} } as unknown as InferenceService;
  sessions = new SessionManager({ store, hub, envs, inference, gateway, prompts: () => prompts });
});

after(async () => {
  await sessions.stopAll();
  await envs.stopAll();
  await gateway.close();
  await fake.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const promptEvents = (sessionId: string) => store.events(sessionId).filter((e) => e.type === "system_prompt");

test("override is sent verbatim, recorded once per change, and dropped on a harness change", async () => {
  const env = await envs.create({ name: "p", type: "sim" });
  const s = await sessions.create({ envId: env.id, modelId: MODEL.id, harness: "terrarium" });

  assert.equal((await sessions.run(s.id, "one")).reason, "done");
  assert.equal(fake.requests.at(-1)!.messages[0].content, TERRARIUM_PROMPT + SIM_NOTE);
  await sessions.run(s.id, "two");
  let recorded = promptEvents(s.id);
  assert.equal(recorded.length, 1, "an unchanged prompt is recorded once");
  assert.ok(recorded[0].type === "system_prompt" && recorded[0].source === "built-in" && recorded[0].tools.join() === "bash,read,write,edit");

  const updated = await sessions.update(s.id, { systemPrompt: "Custom prompt." });
  assert.equal(updated.customPrompt, true);
  await sessions.run(s.id, "three");
  assert.equal(fake.requests.at(-1)!.messages[0].content, "Custom prompt.");
  recorded = promptEvents(s.id);
  assert.equal(recorded.length, 2);
  assert.ok(recorded[1].type === "system_prompt" && recorded[1].source === "session" && recorded[1].text === "Custom prompt.");

  const view = await sessions.prompt(s.id);
  assert.equal(view.source, "session");
  assert.equal(view.defaultText, TERRARIUM_PROMPT + SIM_NOTE);
  assert.deepEqual(view.tools.map((t) => t.name), ["bash", "read", "write", "edit"]);
  assert.equal(view.tokens.exact, false, "not loaded: estimate, no tokenizer call");

  await assert.rejects(sessions.update(s.id, { systemPrompt: "  " }), /systemPrompt/);
  const switched = await sessions.update(s.id, { harness: "pi-stock" });
  assert.equal(switched.customPrompt, undefined);
  assert.equal((await sessions.prompt(s.id)).text, PI_STOCK_PROMPT);
  assert.ok(events.some((e) => e.type === "system_prompt"), "events are broadcast live too");
});

test("a saved profile default replaces the built-in prompt; the sim note is still appended per env", async () => {
  prompts = { terrarium: "Saved default." };
  try {
    const env = await envs.create({ name: "q", type: "sim" });
    const s = await sessions.create({ envId: env.id, modelId: MODEL.id, harness: "terrarium" });
    const view = await sessions.prompt(s.id);
    assert.equal(view.text, "Saved default." + SIM_NOTE);
    assert.equal(view.source, "profile");
    await sessions.run(s.id, "go");
    assert.equal(fake.requests.at(-1)!.messages[0].content, "Saved default." + SIM_NOTE);
  } finally {
    prompts = {};
  }
  assert.deepEqual(sessionPrompt("chat", null, null, {}).source, "built-in");
  assert.equal(toolDefinitions("chat").length, 0);
  const info = harnessInfo({ "pi-stock": "x" });
  assert.equal(info.find((h) => h.id === "pi-stock")?.custom, true);
  assert.ok(info.every((h) => h.tokensEst.prompt > 0));
});

test("settings: validation, saved prompts lose the sim note, null restores the built-in", () => {
  let budget = 12e9;
  const inference = { budget: () => ({ totalBytes: 64e9, budgetBytes: budget }), setBudget: (b: number) => (budget = b), inferenceState: () => ({ status: "stopped" }) };
  const settings = new Settings({ store, hub, inference: inference as unknown as InferenceService, config: { dataDir: dir, modelsDir: dir, venvDir: dir } as any });
  assert.deepEqual(settings.get().newSession, { modelId: null, contextWindow: null, thinking: "model", harness: "terrarium" });
  settings.update({ memoryBudgetBytes: 16e9, newSession: { harness: "pi-stock", contextWindow: 16384 }, newEnv: { network: "registries" } });
  const s = settings.get();
  assert.equal(s.memoryBudgetBytes, 16e9);
  assert.equal(s.newSession.harness, "pi-stock");
  assert.equal(s.newSession.contextWindow, 16384);
  assert.equal(s.newEnv.network, "registries");
  assert.equal(s.newEnv.type, "vm");
  assert.throws(() => settings.update({ newSession: { harness: "chat" as any } }), /harness/);
  assert.throws(() => settings.update({ newEnv: { network: "lan" as any } }), /network/);
  assert.throws(() => settings.update({ newSession: { contextWindow: 100 } }), /contextWindow/);
  settings.update({ prompts: { terrarium: "Mine." + SIM_NOTE } });
  assert.equal(settings.prompts().terrarium, "Mine.");
  settings.update({ prompts: { terrarium: null } });
  assert.equal(settings.prompts().terrarium, undefined);
  assert.throws(() => settings.update({ prompts: { terrarium: "" } }), /non-empty/);
});

test("download repo ids", () => {
  assert.equal(validRepo("LiquidAI/LFM3-1.7B-MLX-4bit"), "LiquidAI/LFM3-1.7B-MLX-4bit");
  assert.equal(validRepo("https://huggingface.co/mlx-community/Qwen3.5-2B-4bit/"), "mlx-community/Qwen3.5-2B-4bit");
  for (const bad of ["", "noslash", "a/b/c", "../x/y", "a/..", "-a/b", "a b/c"]) assert.throws(() => validRepo(bad), /owner\/name/, bad);
});

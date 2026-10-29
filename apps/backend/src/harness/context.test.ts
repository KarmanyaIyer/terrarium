// Context accounting against a fake server whose tokenizer counts like a dense-text model (1 token per 2.6
// characters, where pi-ai's heuristic assumes 3.5): prompts are counted exactly before sending, compaction runs
// before the window is exceeded, a tool output too big for the window is shortened visibly, a message that can't
// fit is refused with the numbers, and a server rejection is explained.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ModelInfo, TraceEvent } from "@terrarium/shared";
import { EnvManager } from "../envs/manager.ts";
import { simDriver } from "../envs/sim/driver.ts";
import { Hub } from "../hub.ts";
import { Gateway } from "../inference/gateway.ts";
import type { InferenceService } from "../inference/service.ts";
import { TokenCounter } from "../inference/tokens.ts";
import { Store } from "../store/db.ts";
import { startFakeOpenAI, type FakeOpenAI, type ScriptedReply } from "../test-support/fake-openai.ts";
import { ESTIMATE_SAFETY, PromptCounter, rawEstimate, TokenCalibrator } from "./budget.ts";
import { explainServerOverflow, SessionManager } from "./sessions.ts";

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

/** The fake model's tokenizer: what both /v1/tokenize and the completion's usage report. */
const dense = (body: Record<string, any>) => Math.ceil((JSON.stringify(body.messages ?? []).length + JSON.stringify(body.tools ?? []).length) / 2.6);

let dir: string;
let store: Store;
let hub: Hub;
let envs: EnvManager;
let fake: FakeOpenAI;
let gateway: Gateway;
let sessions: SessionManager;
let reply: (body: Record<string, any>, n: number) => ScriptedReply = () => ({ text: "done" });
const events: TraceEvent[] = [];
const inference = { model: async (id: string) => (id === MODEL.id ? MODEL : null), ensureModel: async () => {} } as unknown as InferenceService;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "terrarium-ctx-"));
  store = new Store(join(dir, "db.sqlite"), join(dir, "blobs"));
  hub = new Hub();
  hub.listen((m) => {
    if (m.type === "trace") events.push(m.event);
  });
  fake = await startFakeOpenAI((body, n) => reply(body, n), { promptTokens: dense });
  gateway = new Gateway(store, { baseUrl: () => fake.origin, apiKey: () => "k", ensureReady: async () => {} });
  await gateway.listen();
  envs = new EnvManager({ store, hub, dataDir: dir, drivers: { sim: simDriver, vm: null } });
  const tokens = new TokenCounter({ baseUrl: () => fake.origin, apiKey: () => "k", ensureReady: async () => {} });
  sessions = new SessionManager({ store, hub, envs, inference, gateway, tokens });
});

after(async () => {
  await sessions.stopAll();
  await envs.stopAll();
  await gateway.close();
  await fake.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const of = <T extends TraceEvent["type"]>(sessionId: string, type: T) => store.events(sessionId).filter((e) => e.type === type) as Extract<TraceEvent, { type: T }>[];

test("every prompt is counted before sending and equals the server's prompt_tokens; compaction keeps prompt + output inside the window", async () => {
  const env = await envs.create({ name: "ctx", type: "sim" });
  const s = await sessions.create({ envId: env.id, modelId: MODEL.id, harness: "terrarium", contextWindow: 8192 });
  assert.equal(s.maxOutputTokens, 2048);
  // Big tool outputs (each ~6,000 characters to the model, ~2,300 tokens here), then a long reply, twice.
  const plan: ScriptedReply[] = [];
  for (let i = 0; i < 5; i++) plan.push({ toolCall: { name: "bash", args: { command: `seq ${i * 1000} ${i * 1000 + 1400}` } } });
  plan.push({ text: "Summary: ".concat("the numbers rise steadily. ".repeat(160)) });
  for (let i = 0; i < 4; i++) plan.push({ toolCall: { name: "bash", args: { command: `seq ${i} 2 3000` } } });
  plan.push({ text: "Second summary. ".repeat(100) });
  const start = fake.requests.length;
  reply = (_b, n) => plan[n - start] ?? { text: "done" };
  const a = await sessions.run(s.id, "Print some number ranges and summarize them.", { maxTurns: 20 });
  assert.equal(a.reason, "done", a.error);
  const b = await sessions.run(s.id, "Now the odd numbers, then summarize again.", { maxTurns: 20 });
  assert.equal(b.reason, "done", b.error);

  const starts = of(s.id, "model_call_start");
  const ends = of(s.id, "model_call_end");
  assert.equal(starts.length, 11);
  for (const st of starts) {
    const end = ends.find((e) => e.callId === st.callId)!;
    assert.equal(st.promptCount, "tokenizer");
    assert.equal(end.usage?.promptTokens, st.promptTokensEst, `call ${st.callId}: counted ${st.promptTokensEst}, server ${end.usage?.promptTokens}`);
    assert.ok(st.promptTokensEst + st.maxTokens <= 8192, `prompt ${st.promptTokensEst} + output ${st.maxTokens} within the window`);
    assert.equal(end.finishReason === "length", false);
  }
  // Every request the server got fits: its own count plus max_tokens <= window.
  for (const req of fake.requests.slice(start)) assert.ok(dense(req) + req.max_tokens <= 8192);
  const compactions = of(s.id, "compaction");
  assert.ok(compactions.length >= 2, `${compactions.length} compactions`);
  for (const c of compactions) {
    assert.equal(c.exact, true);
    assert.ok(c.afterTokens <= c.limit!, `after ${c.afterTokens} <= limit ${c.limit}`);
    assert.ok(c.beforeTokens > c.limit!);
  }
  // The meter: the context event at each call start is the counted prompt and that call's budget.
  const ctx = of(s.id, "context");
  const counted = ctx.filter((c) => c.usage.source === "tokenizer");
  assert.equal(counted.length, 11);
  for (const c of counted) assert.ok(c.usage.systemAndTools + c.usage.history + c.usage.outputReserve <= 8192);
  // System prompt + tools is the tokenizer's count (with an empty user turn, minus that turn), the same in both runs.
  const withEmpty = fake.tokenizeRequests.find((r) => r.messages?.length === 2 && r.messages[0].role === "system" && r.messages[1].role === "user" && r.messages[1].content === "")!;
  assert.ok(withEmpty, "system counted with an empty user turn");
  const sysExact = dense(withEmpty) - dense({ messages: [{ role: "user", content: "" }] });
  for (const c of ctx) assert.equal(c.usage.systemAndTools, sysExact);
});

test("a tool output too big for the window by itself is shortened with a visible marker; the original is kept in a blob", async () => {
  const env = await envs.create({ name: "ctx2", type: "sim" });
  const s = await sessions.create({ envId: env.id, modelId: MODEL.id, harness: "terrarium", contextWindow: 2048 });
  assert.equal(s.maxOutputTokens, 512);
  const start = fake.requests.length;
  reply = (_b, n) => (n === start ? { toolCall: { name: "bash", args: { command: "seq 100000 101200" } } } : { text: "The output starts at 100000." });
  const out = await sessions.run(s.id, "Print a range.", { maxTurns: 5 });
  assert.equal(out.reason, "done", out.error);
  const c = of(s.id, "compaction").at(-1)!;
  assert.ok(c.shortened?.length === 1, JSON.stringify(c));
  const sh = c.shortened[0];
  const toolEnd = of(s.id, "tool_end")[0];
  assert.equal(sh.toolCallId, toolEnd.toolCallId);
  assert.ok(sh.total > 1280 && sh.keptHead > 0 && sh.keptTail > 0 && sh.keptHead + sh.keptTail < sh.total, JSON.stringify(sh));
  // The full original (what the tool returned to the model) is in the blob.
  assert.equal(store.blobs.getText(sh.originalBlob!), toolEnd.resultForModel);
  // The model saw the marker with the same numbers.
  const req = fake.requests[start + 1];
  const tool = req.messages.find((m: any) => m.role === "tool");
  const toolText = typeof tool.content === "string" ? tool.content : tool.content.map((p: any) => p.text).join("");
  assert.match(toolText, new RegExp(`kept the first ${sh.keptHead} and last ${sh.keptTail} of ${sh.total} tokens`));
  assert.ok(dense(req) + req.max_tokens <= 2048);
});

test("a message that can't fit even after compaction is refused before sending, with the numbers and the remedy", async () => {
  const s = await sessions.create({ envId: null, modelId: MODEL.id, harness: "chat", contextWindow: 2048 });
  const before = fake.requests.length;
  const tokenizesBefore = fake.tokenizeRequests.length;
  const out = await sessions.run(s.id, `Notes: ${Array.from({ length: 900 }, (_, i) => `amber${i * 7919}`).join(" ")}`);
  assert.equal(out.reason, "error");
  assert.equal(fake.requests.length, before, "no completion request was sent");
  assert.ok(fake.tokenizeRequests.length > tokenizesBefore);
  assert.equal(of(s.id, "model_call_start").length, 0);
  const err = of(s.id, "error")[0];
  assert.equal(err.code, "context_overflow");
  assert.match(err.message, /^Request not sent: the prompt is [\d,]+ tokens after compaction, over the 2,048-token context window\.$/);
  assert.ok((err.data!.promptTokens as number) > 2048);
  assert.equal(err.data!.counted, "tokenizer");
  assert.equal(err.data!.suggestedWindow, 8192);
  assert.match(err.detail!, /Latest user message: [\d,]+ tokens\./);
  assert.match(err.detail!, /Raise the context window to 8,192, or send a shorter message\./);
  // The meter shows the real prompt, never a negative free.
  const ctx = of(s.id, "context").at(-1)!;
  assert.equal(ctx.usage.source, "tokenizer");
  assert.equal(ctx.usage.systemAndTools + ctx.usage.history, err.data!.promptTokens);
  assert.equal(ctx.usage.free, 0);
});

test("when the tokenizer is unreachable, a server rejection is shown with its numbers and the remedy", async () => {
  const noTok = new SessionManager({ store, hub, envs, inference, gateway });
  const s = await noTok.create({ envId: null, modelId: MODEL.id, harness: "chat", contextWindow: 16384 });
  const start = fake.requests.length;
  reply = (_b, n) => (n === start ? { status: 400, error: "Prompt is too long: 38909 tokens > 32768 maximum context length" } : { text: "ok" });
  const out = await noTok.run(s.id, "a long paste");
  assert.equal(out.reason, "error");
  const st = of(s.id, "model_call_start")[0];
  assert.equal(st.promptCount, "estimate");
  const err = of(s.id, "error")[0];
  assert.equal(err.code, "context_overflow");
  assert.equal(err.message, "The inference server rejected the request: the prompt is 38,909 tokens, over the 32,768-token context the model is loaded with (session window 16,384).");
  assert.equal(err.data!.promptTokens, 38909);
  assert.equal(err.data!.serverMaxContext, 32768);
  assert.match(err.detail!, /Prompt is too long: 38909 tokens > 32768/);
  assert.match(err.detail!, /This needs more than the model's 32,768-token native context|start a new session or shorten the last message/);
});

test("explainServerOverflow suggests the smallest window that fits within the model's native context", () => {
  const e = explainServerOverflow("400 Prompt is too long: 9000 tokens > 8192 maximum context length", 8192, 1024, 32768)!;
  assert.equal(e.data.suggestedWindow, 16384);
  assert.match(e.detail, /Raise the session's context window to 16,384 or more/);
  assert.equal(explainServerOverflow("400 something else", 8192, 1024, 32768), null);
});

test("PromptCounter: exact with a tokenizer, safety-scaled estimate without, and server usage corrects later counts", async () => {
  const msgs = [{ role: "user", content: "x".repeat(3500), timestamp: 0 }] as AgentMessage[];
  const body = async (m: unknown[]) => ({ messages: m, tools: [] });
  let n = 1000;
  const tok = { countChat: async () => n, countText: async (_m: string, t: string) => t.length };
  const c = new PromptCounter({ modelId: "m", tokenizer: tok, calibrator: new TokenCalibrator(), body });
  const first = await c.count(msgs);
  assert.deepEqual(first, { tokens: 1000, exact: true, tokenized: 1000 });
  c.observe(first, rawEstimate(msgs), 1012);
  assert.equal((await c.count(msgs)).tokens, 1012, "the server counted 12 more: later counts add them");
  c.observe({ tokens: 1012, exact: true, tokenized: 1000 }, rawEstimate(msgs), 1000);
  assert.equal((await c.count(msgs)).tokens, 1000);

  const broken = { countChat: async () => Promise.reject(new Error("down")), countText: async () => Promise.reject(new Error("down")) };
  const e = new PromptCounter({ modelId: "m", tokenizer: broken, calibrator: new TokenCalibrator(), body });
  const est = await e.count(msgs);
  assert.equal(est.exact, false);
  assert.equal(est.tokens, Math.ceil(rawEstimate(msgs) * ESTIMATE_SAFETY));
  assert.equal(e.lastFailure, "down");
  n = 0;

  // System prompt + tools: templates refuse a chat with no user turn, so it is counted with an empty one,
  // minus that turn alone (Qwen3.5: 10 tokens of user wrapper and generation prompt).
  const sys = [{ role: "system", content: "You are terse.", timestamp: 0 }] as AgentMessage[];
  const qwen = {
    countChat: async (b: { messages: unknown[] }) => {
      const roles = (b.messages as { role: string }[]).map((m) => m.role);
      if (!roles.includes("user")) throw new Error("Chat template error: No user query found in messages.");
      return roles.includes("system") ? 280 : 10;
    },
    countText: async () => 0,
  };
  const q = new PromptCounter({ modelId: "m", tokenizer: qwen, calibrator: new TokenCalibrator(), body });
  assert.deepEqual(await q.countSystem(sys), { tokens: 270, exact: true });
  assert.equal(q.lastFailure, null);
  assert.deepEqual(await e.countSystem(sys), { tokens: e.estimate(sys), exact: false });
});

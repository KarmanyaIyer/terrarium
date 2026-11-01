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
import { conservativeTokens, PromptCounter, rawEstimate, TokenCalibrator } from "./budget.ts";
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
  assert.match(err.detail!, /Raise the context window to 8,192 \(output cap 512\), or send a shorter message, then retry\./);
  // The meter shows the real prompt, never a negative free.
  const ctx = of(s.id, "context").at(-1)!;
  assert.equal(ctx.usage.source, "tokenizer");
  assert.equal(ctx.usage.systemAndTools + ctx.usage.history, err.data!.promptTokens);
  assert.equal(ctx.usage.free, 0);
});

const textOfMsg = (m: { content: unknown }) => (typeof m.content === "string" ? m.content : (m.content as { text?: string }[]).map((p) => p.text ?? "").join(""));
const settled = async (id: string) => {
  for (let i = 0; i < 500 && sessions.isRunning(id); i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(sessions.isRunning(id), false, "the run ended");
};
const paste = (words: number) => `Notes: ${Array.from({ length: words }, (_, i) => `amber${i * 7919}`).join(" ")}`;

test("over the window: the suggested window is one compaction keeps the message whole in, and Retry sends it again as the current instruction (review 4, #3)", async () => {
  const s = await sessions.create({ envId: null, modelId: MODEL.id, harness: "chat", contextWindow: 8192, thinking: true });
  assert.equal(s.maxOutputTokens, 4096, "thinking on: the cap is half the window");
  const text = paste(2700); // ~14,000 tokens, like the review's 14,059-token paste
  const before = fake.requests.length;
  assert.equal((await sessions.run(s.id, text)).reason, "error");
  assert.equal(fake.requests.length, before, "refused, not sent");
  const err = of(s.id, "error").at(-1)!;
  const prompt = err.data!.promptTokens as number;
  const want = err.data!.suggestedWindow as number;
  // Old sizing (prompt + min(cap, 1024) + 320) named 16K for this prompt; compaction's limit there is 16,384 - 4,096 - 256.
  assert.ok(prompt > 12032 && prompt + 1024 + 320 <= 16384, `a ${prompt}-token prompt: more than compaction keeps in 16K with a 4,096 cap`);
  assert.ok(want - 4096 - 256 >= prompt, `in ${want}, compaction's limit ${want - 4096 - 256} holds the ${prompt}-token prompt`);
  assert.match(err.detail!, new RegExp(`Raise the context window to ${want.toLocaleString("en-US")} \\(output cap 4,096\\), or send a shorter message, then retry\\.`));
  assert.match(err.detail!, /Your message is kept in the conversation without a reply\. Retry sends it again/);

  // The remedy as the UI applies it (window raised, cap kept), then Retry.
  await sessions.update(s.id, { contextWindow: want, maxOutputTokens: 4096 });
  reply = () => ({ text: "The notes are amber numbers." });
  const sent = fake.requests.length;
  sessions.retry(s.id);
  await settled(s.id);
  const req = fake.requests[sent];
  assert.ok(req, "the retry was sent");
  const users = req.messages.filter((m: { role: string }) => m.role === "user");
  assert.equal(users.length, 1, "the message went once, not twice");
  assert.equal(textOfMsg(users[0]), text, "whole: nothing dropped or shortened");
  assert.equal(req.messages.at(-1).role, "user", "it is the current instruction");
  assert.ok(dense(req) + req.max_tokens <= want);
  assert.equal(req.max_tokens, 4096, "the full output cap");
  const um = of(s.id, "user_message");
  assert.equal(um.length, 2);
  assert.equal(um[1].retry, "message");
  assert.equal(um[1].text, text);
  assert.equal(of(s.id, "run_end").at(-1)!.reason, "done");
  assert.throws(() => sessions.retry(s.id), /nothing to retry: the latest message already has a reply/);
});

test("refused mid-run, after tool steps: the detail says so, and Retry runs that step again instead of failing", async () => {
  const env = await envs.create({ name: "midrun", type: "sim" });
  const s = await sessions.create({ envId: env.id, modelId: MODEL.id, harness: "terrarium", contextWindow: 4096 });
  // The model's own tool call is too big to leave reply room; compaction keeps the newest step, so it can't help.
  const start = fake.requests.length;
  reply = (_b, n) => (n === start ? { toolCall: { name: "bash", args: { command: `echo ${paste(1000)} > /dev/null` } } } : { text: "Done." });
  assert.equal((await sessions.run(s.id, "Echo some notes.", { maxTurns: 5 })).reason, "error");
  assert.equal(fake.requests.length, start + 1, "the step after the tool call was refused, not sent");
  const err = of(s.id, "error").at(-1)!;
  assert.equal(err.code, "context_overflow");
  assert.doesNotMatch(err.detail!, /without a reply/, "the message has replies (the tool step)");
  assert.match(err.detail!, /The run stopped before this step; its steps so far are kept\. Retry runs this step again/);

  await sessions.update(s.id, { contextWindow: err.data!.suggestedWindow as number });
  sessions.retry(s.id);
  await settled(s.id);
  assert.equal(fake.requests.length, start + 2, "the refused step was sent");
  const req = fake.requests[start + 1];
  assert.equal(req.messages.at(-1).role, "tool", "from the latest tool result");
  assert.equal(req.messages.filter((m: { role: string }) => m.role === "user").length, 1, "nothing added");
  const um = of(s.id, "user_message").at(-1)!;
  assert.equal(um.retry, "step");
  assert.equal(um.text, "Echo some notes.");
  assert.equal(of(s.id, "run_end").at(-1)!.reason, "done");
  assert.throws(() => sessions.retry(s.id), /nothing to retry/);
});

test("a new message after a refused one: the trace says whether the model sees the refused one (review 4, #3)", async () => {
  // Still too small: compaction drops the refused paste, and says so.
  const a = await sessions.create({ envId: null, modelId: MODEL.id, harness: "chat", contextWindow: 2048 });
  assert.equal((await sessions.run(a.id, paste(900))).reason, "error");
  reply = () => ({ text: "hi" });
  const sentA = fake.requests.length;
  assert.equal((await sessions.run(a.id, "Never mind, just say hi.")).reason, "done");
  assert.ok(!fake.requests[sentA].messages.some((m: { content: unknown }) => textOfMsg(m as { content: unknown }).includes("amber7919")), "the paste was not sent");
  const dropped = of(a.id, "warning").filter((w) => w.code === "other" && /earlier message that got no reply/.test(w.message));
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].message, /^Your earlier message that got no reply \([\d,]+ tokens\) was removed by compaction to fit the 2,048-token window: the model does not see it\.$/);

  // Window raised, but a new message instead of Retry: the paste goes as an earlier turn.
  const b = await sessions.create({ envId: null, modelId: MODEL.id, harness: "chat", contextWindow: 2048 });
  assert.equal((await sessions.run(b.id, paste(900))).reason, "error");
  await sessions.update(b.id, { contextWindow: 16384 });
  const sentB = fake.requests.length;
  assert.equal((await sessions.run(b.id, "Summarize the notes.")).reason, "done");
  const users = fake.requests[sentB].messages.filter((m: { role: string }) => m.role === "user");
  assert.equal(users.length, 2);
  assert.match(textOfMsg(users[0]), /^Notes: amber0/);
  const kept = of(b.id, "warning").filter((w) => w.code === "other" && /earlier message that got no reply/.test(w.message));
  assert.match(kept[0]?.message ?? "", /^Your earlier message that got no reply \([\d,]+ tokens\) is sent as an earlier turn\.$/);
});

test("Send and Continue on a session whose environment was deleted are refused with that reason (review 4, #11)", async () => {
  const env = await envs.create({ name: "gone", type: "sim" });
  const s = await sessions.create({ envId: env.id, modelId: MODEL.id, harness: "terrarium" });
  await envs.delete(env.id);
  assert.throws(() => sessions.sendMessage(s.id, "hello"), (e: Error & { status?: number }) => e.status === 409 && /^enclosure deleted: this session's enclosure no longer exists/.test(e.message));
  assert.throws(() => sessions.continue(s.id), /enclosure deleted/);
  assert.equal(of(s.id, "user_message").length, 0, "no run started");
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

test("PromptCounter: exact with a tokenizer, an estimate that errs high without, and server usage corrects later counts", async () => {
  const msgs = [{ role: "user", content: "x".repeat(3500), timestamp: 0 }] as AgentMessage[];
  const body = async (m: unknown[]) => ({ messages: m, tools: [] });
  let n = 1000;
  const tok = { countChat: async () => n, countText: async (_m: string, t: string) => t.length };
  const c = new PromptCounter({ modelId: "m", tokenizer: tok, calibrator: new TokenCalibrator(), body });
  const first = await c.count(msgs);
  assert.deepEqual({ tokens: first.tokens, exact: first.exact, tokenized: first.tokenized }, { tokens: 1000, exact: true, tokenized: 1000 });
  c.observe(first, rawEstimate(msgs), 1012);
  assert.equal((await c.count(msgs)).tokens, 1012, "the server counted 12 more: later counts add them");
  c.observe({ tokens: 1012, exact: true, tokenized: 1000 }, rawEstimate(msgs), 1000);
  assert.equal((await c.count(msgs)).tokens, 1000);

  const broken = { countChat: async () => Promise.reject(new Error("down")), countText: async () => Promise.reject(new Error("down")) };
  const e = new PromptCounter({ modelId: "m", tokenizer: broken, calibrator: new TokenCalibrator(), body });
  const est = await e.count(msgs);
  assert.equal(est.exact, false);
  assert.ok(est.tokens >= conservativeTokens("x".repeat(3500)), `estimate ${est.tokens}`);
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
  const es = await e.countSystem(sys);
  assert.equal(es.exact, false);
  assert.ok(es.tokens >= conservativeTokens("You are terse."), `system estimate ${es.tokens}`);
});

test("PromptCounter: each run's first count may wait for the model to load (evicted since the last run), later ones don't", async () => {
  const msgs = [{ role: "user", content: "hi", timestamp: 0 }] as AgentMessage[];
  const body = async (m: unknown[]) => ({ messages: m });
  const seen: (boolean | undefined)[] = [];
  let fail = true;
  const tok = {
    countChat: async (_b: unknown, _s?: AbortSignal, mayLoad?: boolean) => (seen.push(mayLoad), fail ? Promise.reject(new Error("loading")) : 5),
    countText: async (_m: string, _t: string, _s?: AbortSignal, mayLoad?: boolean) => (seen.push(mayLoad), 1),
  };
  const calibrator = new TokenCalibrator();
  await new PromptCounter({ modelId: "m", tokenizer: tok, calibrator, body }).count(msgs);
  fail = false;
  const run = new PromptCounter({ modelId: "m", tokenizer: tok, calibrator, body });
  await run.count(msgs);
  await run.count(msgs);
  await run.countText("x");
  await new PromptCounter({ modelId: "m", tokenizer: tok, calibrator, body }).countText("x");
  assert.deepEqual(seen, [true, true, false, false, true]);
});

// The pi-ai 4,096-token clamp: show it bites on an 8K window and that our stream function doesn't apply it.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { Hub } from "../hub.ts";
import { Gateway } from "../inference/gateway.ts";
import { Store } from "../store/db.ts";
import { startFakeOpenAI, type FakeOpenAI } from "../test-support/fake-openai.ts";
import { SessionTracer } from "../trace.ts";
import { callBudget, rawEstimate, TokenCalibrator } from "./budget.ts";
import { makeStreamFn, omlxModel } from "./stream.ts";

let dir: string;
let store: Store;
let fake: FakeOpenAI;
let gateway: Gateway;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "terrarium-clamp-"));
  store = new Store(join(dir, "db.sqlite"), join(dir, "blobs"));
  let n = 0;
  fake = await startFakeOpenAI(() => (n++ === 0 ? { status: 500, error: "incomplete_tool_call: Model output contains an unrecoverable tool call." } : { text: "ok" }));
  gateway = new Gateway(store, { baseUrl: () => fake.origin, apiKey: () => "k", ensureReady: async () => {} });
  await gateway.listen();
  store.run("INSERT INTO sessions (id, title, model_id, harness, context_window, max_output_tokens, status, created_at, updated_at) VALUES ('s', 't', 'm', 'chat', 8192, 2048, 'idle', 0, 0)");
});

after(async () => {
  await gateway.close();
  await fake.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

// ~4,800 estimated prompt tokens: a mid-length agent session in an 8K window.
const longContext = (): Message[] => [
  { role: "system", content: "You are an agent.", timestamp: 0 },
  { role: "user", content: `Here is a log:\n${"error at line 42 in module foo\n".repeat(540)}`, timestamp: 0 },
];

test("pi-ai's own clamp leaves almost nothing at 8K; callBudget keeps the session budget", () => {
  const model = omlxModel("m", 8192, 2048);
  const ctx = normalizeContext({ messages: longContext() });
  const est = rawEstimate(longContext() as AgentMessage[]);
  assert.ok(est > 4000 && est < 5500, `estimate ${est}`);
  const clamped = clampMaxTokensToContext(model, ctx, 2048);
  assert.ok(clamped <= 64, `pi-ai clamp gives ${clamped}`);
  assert.equal(callBudget(8192, est, 2048), 2048);
  // Near the edge the budget shrinks to what actually fits, never to a fixed 4,096 margin.
  assert.equal(callBudget(8192, 7000, 2048), 8192 - 7000 - 64);
});

test("streamSimple sends the clamped max_tokens; our stream function sends the real budget", async () => {
  fake.requests.length = 0;
  const model = omlxModel("m", 8192, 2048);
  // pi-ai path (what the Agent would do by default). Skip the scripted 500 first.
  const tracer = new SessionTracer("s", 0, store, new Hub());
  const reg = gateway.register({ tracer, callId: "pre", modelId: "m", turn: 0, contextWindow: 8192, maxTokens: 1, promptTokensEst: 1 });
  await fetch(`${reg.baseUrl}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${gateway.apiKey}`, "Content-Type": "application/json" }, body: "{}" }).then((r) => r.text());
  const reg2 = gateway.register({ tracer, callId: "simple", modelId: "m", turn: 0, contextWindow: 8192, maxTokens: 2048, promptTokensEst: 0 });
  const s1 = streamSimple({ ...model, baseUrl: reg2.baseUrl }, normalizeContext({ messages: longContext() }), { apiKey: gateway.apiKey, maxTokens: 2048 });
  await s1.result();
  const piBody = fake.requests.at(-1)!;
  assert.ok(piBody.max_tokens <= 64, `pi-ai sent max_tokens ${piBody.max_tokens}`);

  // Ours, same model and context (the scripted 500 was consumed by the "pre" call above).
  const retries: number[] = [];
  const ends: number[] = [];
  const fn = makeStreamFn({
    gateway,
    tracer,
    calibrator: new TokenCalibrator(),
    params: () => ({ modelId: "m", window: 8192, maxOutput: 2048, thinking: false, sampling: { temperature: 0.7, topP: 0.8, topK: 20, presencePenalty: 1.5 }, turn: 1 }),
    ensureReady: async () => {},
    toolNames: () => [],
    fencedBash: false,
    onCallEnd: (r, info) => ends.push(info.maxTokens),
    onRepair: () => {},
    onRetry: (_id, attempt) => retries.push(attempt),
  });
  const msg = await (await fn(model, normalizeContext({ messages: longContext() }), {})).result();
  assert.equal(msg.stopReason, "stop");
  const body = fake.requests.at(-1)!;
  assert.equal(body.max_tokens, 2048);
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
  assert.equal(body.top_k, 20);
  assert.equal(body.presence_penalty, 1.5);
  assert.equal(body.temperature, 0.7);
  assert.equal(body.top_p, 0.8);
  assert.equal(retries.length, 0);
});

test("a server-side tool parse error is retried, and the retry is reported", async () => {
  let n = 0;
  const flaky = await startFakeOpenAI(() => (n++ === 0 ? { status: 500, error: "incomplete_tool_call: Model output contains an unrecoverable tool call." } : { text: "second try worked" }));
  const gw = new Gateway(store, { baseUrl: () => flaky.origin, apiKey: () => "k", ensureReady: async () => {} });
  await gw.listen();
  try {
    const retries: number[] = [];
    const fn = makeStreamFn({
      gateway: gw,
      tracer: new SessionTracer("s", 100, store, new Hub()),
      calibrator: new TokenCalibrator(),
      params: () => ({ modelId: "m", window: 8192, maxOutput: 1024, thinking: true, sampling: { temperature: 1, topP: 0.95 }, turn: 1 }),
      ensureReady: async () => {},
      toolNames: () => ["bash"],
      fencedBash: false,
      onCallEnd: () => {},
      onRepair: () => {},
      onRetry: (_id, attempt) => retries.push(attempt),
    });
    const msg = await (await fn(omlxModel("m", 8192, 1024), normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] }), {})).result();
    assert.equal(msg.stopReason, "stop");
    assert.equal((msg.content[0] as { text: string }).text, "second try worked");
    assert.deepEqual(retries, [1]);
    assert.equal(flaky.requests.length, 2);
    assert.deepEqual(flaky.requests[1].chat_template_kwargs, { enable_thinking: true });
  } finally {
    await gw.close();
    await flaky.close();
  }
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { TraceEvent } from "@terrarium/shared";
import { Hub } from "../hub.ts";
import { sha256 } from "../store/blobs.ts";
import { Store } from "../store/db.ts";
import { BlobGc } from "../store/gc.ts";
import { startFakeOpenAI, type FakeOpenAI } from "../test-support/fake-openai.ts";
import { SessionTracer } from "../trace.ts";
import { Gateway } from "./gateway.ts";

let dir: string;
let store: Store;
let hub: Hub;
let fake: FakeOpenAI;
let gateway: Gateway;
const events: TraceEvent[] = [];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "terrarium-gw-"));
  store = new Store(join(dir, "db.sqlite"), join(dir, "blobs"));
  hub = new Hub();
  hub.listen((m) => {
    if (m.type === "trace") events.push(m.event);
  });
  fake = await startFakeOpenAI([
    { text: "Hello there, world.", reasoning: "think first" },
    { toolCall: { name: "bash", args: { command: "ls -la" } } },
    { text: "cut off", finish: "length" },
    { status: 500, error: "model exploded" },
    { text: "plain json" },
    { streamError: "RuntimeError: sidecar fell over" },
  ]);
  gateway = new Gateway(store, { baseUrl: () => fake.origin, apiKey: () => "upstream-key", ensureReady: async () => {} });
  await gateway.listen();
  store.run("INSERT INTO sessions (id, title, model_id, harness, context_window, max_output_tokens, status, created_at, updated_at) VALUES ('s1', 't', 'm', 'chat', 8192, 2048, 'idle', 0, 0)");
});

after(async () => {
  await gateway.close();
  await fake.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const tracer = () => new SessionTracer("s1", store.get<{ last_seq: number }>("SELECT last_seq FROM sessions WHERE id = 's1'")!.last_seq, store, hub);

async function call(callId: string, body: Record<string, unknown>, key = gateway.apiKey) {
  const reg = gateway.register({ tracer: tracer(), callId, modelId: "m", turn: 1, contextWindow: 8192, maxTokens: 777, promptTokensEst: 100 });
  const res = await fetch(`${reg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { res, text, result: res.status === 401 ? null : await reg.result };
}

test("streams through, records exact request, raw SSE, usage, timing and events", async () => {
  const body = { model: "m", stream: true, max_tokens: 777, messages: [{ role: "user", content: "hi" }], chat_template_kwargs: { enable_thinking: false } };
  const { res, text, result } = await call("c1", body);
  assert.equal(res.status, 200);
  assert.match(text, /\[DONE\]/);
  assert.equal(result!.finishReason, "stop");
  assert.ok((result!.usage?.promptTokens ?? 0) > 0);
  assert.equal(result!.timing.ttftMs, 50);
  assert.equal(result!.timing.genTps, 50);
  // Upstream got our key, not the session's.
  assert.deepEqual(fake.requests[0], body);
  const row = store.get<Record<string, any>>("SELECT * FROM model_calls WHERE id = 'c1'")!;
  assert.deepEqual(store.blobs.getJson(row.request_blob), body);
  assert.match(store.blobs.getText(row.raw_blob)!, /chat\.completion\.chunk/);
  const response = store.blobs.getJson<any>(row.response_blob);
  assert.equal(response.choices[0].message.content, "Hello there, world.");
  assert.equal(response.choices[0].message.reasoning_content, "think first");
  assert.equal(row.finish_reason, "stop");
  assert.equal(row.max_tokens, 777);
  const types = events.filter((e) => "callId" in e && (e as any).callId === "c1").map((e) => e.type);
  assert.equal(types[0], "model_call_start");
  assert.ok(types.includes("model_delta"));
  assert.equal(types.at(-1), "model_call_end");
  const start = events.find((e) => e.type === "model_call_start" && e.callId === "c1")!;
  assert.equal(row.seq, start.seq, "model_calls.seq is the start event's seq");
});

test("tool call deltas and tool_calls finish reason", async () => {
  const { result } = await call("c2", { model: "m", stream: true, messages: [{ role: "user", content: "x" }] });
  assert.equal(result!.finishReason, "tool_calls");
  const resp = result!.response as any;
  assert.equal(resp.choices[0].message.tool_calls[0].function.name, "bash");
  assert.deepEqual(JSON.parse(resp.choices[0].message.tool_calls[0].function.arguments), { command: "ls -la" });
});

test("length finish reason is reported", async () => {
  const { result } = await call("c3", { model: "m", stream: true, messages: [{ role: "user", content: "x" }] });
  assert.equal(result!.finishReason, "length");
  const end = events.find((e) => e.type === "model_call_end" && e.callId === "c3");
  assert.equal(end?.type === "model_call_end" && end.finishReason, "length");
});

test("upstream error is recorded and forwarded", async () => {
  const { res, result } = await call("c4", { model: "m", stream: true, messages: [{ role: "user", content: "x" }] });
  assert.equal(res.status, 500);
  assert.equal(result!.finishReason, "error");
  assert.match(result!.error ?? "", /model exploded|500/);
});

test("non-streaming responses are recorded", async () => {
  const { res, result } = await call("c5", { model: "m", stream: false, messages: [{ role: "user", content: "x" }] });
  assert.equal(res.status, 200);
  assert.equal(result!.finishReason, "stop");
  assert.equal((result!.response as any).choices[0].message.content, "plain json");
});

test("an error event after the 200 headers is recorded as an error, not a stop", async () => {
  const { res, result } = await call("c5b", { model: "m", stream: true, messages: [{ role: "user", content: "x" }] });
  assert.equal(res.status, 200);
  assert.equal(result!.finishReason, "error");
  assert.match(result!.error ?? "", /sidecar fell over/);
});

test("rejects a wrong gateway key and unknown call ids", async () => {
  const { res } = await call("c6", { model: "m", messages: [] }, "wrong");
  assert.equal(res.status, 401);
  const r = await fetch(`http://127.0.0.1:${new URL((gateway.register({ tracer: tracer(), callId: "c7", modelId: "m", turn: 1, contextWindow: 1, maxTokens: 1, promptTokensEst: 1 })).baseUrl).port}/s/s1/nope/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${gateway.apiKey}`, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(r.status, 404);
  gateway.cancel("c7", "unused");
});

test("blob GC keeps the request of a call still in flight (review 2, #11)", async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const slow = new Gateway(store, { baseUrl: () => fake.origin, apiKey: () => "upstream-key", ensureReady: () => held });
  await slow.listen();
  try {
    const body = { model: "m", stream: false, messages: [{ role: "user", content: "a long call" }] };
    const reg = slow.register({ tracer: tracer(), callId: "c-long", modelId: "m", turn: 1, contextWindow: 8192, maxTokens: 64, promptTokensEst: 10 });
    const res = fetch(`${reg.baseUrl}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${slow.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    let start: TraceEvent | undefined;
    for (let i = 0; i < 100 && !start; i++) {
      await new Promise((r) => setTimeout(r, 10));
      start = events.find((e) => e.type === "model_call_start" && e.callId === "c-long");
    }
    assert.ok(start, "the call started");
    const sha = sha256(JSON.stringify(body));
    assert.equal(start.type === "model_call_start" && start.requestBlob, sha, "the start event names the request blob");
    assert.equal(store.get("SELECT id FROM model_calls WHERE id = 'c-long'"), undefined, "no row yet: the call is running");
    // The call has been running past GC's grace period and a deletion triggers a sweep.
    const old = new Date(Date.now() - 3600_000);
    utimesSync(join(store.blobs.dir, sha.slice(0, 2), sha), old, old);
    await new BlobGc(store).run({ graceMs: 60_000 });
    assert.ok(store.blobs.has(sha), "request blob survives the sweep");
    release();
    await (await res).text();
    await reg.result;
    const row = store.get<{ request_blob: string }>("SELECT request_blob FROM model_calls WHERE id = 'c-long'")!;
    assert.equal(row.request_blob, sha);
    assert.deepEqual(store.blobs.getJson(sha), body);
  } finally {
    release();
    await slow.close();
  }
});

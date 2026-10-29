import assert from "node:assert/strict";
import { test } from "node:test";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { parseTextToolCalls, repairMessage, withTextToolCallFallback } from "./fallback.ts";

const TOOLS = ["bash", "read", "write", "edit"];

test("qwen3_coder XML in text", () => {
  const r = parseTextToolCalls("Let me look.\n<tool_call>\n<function=bash>\n<parameter=command>\nls -la\n</parameter>\n</function>\n</tool_call>", TOOLS)!;
  assert.deepEqual(r.calls, [{ name: "bash", arguments: { command: "ls -la" } }]);
  assert.equal(r.text, "Let me look.");
});

test("Hermes <tool_call> JSON, including arguments as a string", () => {
  const r = parseTextToolCalls('<tool_call>{"name": "read", "arguments": "{\\"path\\": \\"a.py\\"}"}</tool_call>', TOOLS)!;
  assert.deepEqual(r.calls, [{ name: "read", arguments: { path: "a.py" } }]);
});

test("Gemma 4 call markup with <|\"|> string delimiters", () => {
  const r = parseTextToolCalls('<|tool_call>call:bash{command:<|"|>python3 a.py<|"|>}<tool_call|>', TOOLS)!;
  assert.deepEqual(r.calls, [{ name: "bash", arguments: { command: "python3 a.py" } }]);
});

test("bare JSON reply, fenced or not", () => {
  assert.deepEqual(parseTextToolCalls('{"name":"write","arguments":{"path":"x","content":"y"}}', TOOLS)!.calls, [{ name: "write", arguments: { path: "x", content: "y" } }]);
  assert.deepEqual(parseTextToolCalls('```json\n{"name":"bash","parameters":{"command":"pwd"}}\n```', TOOLS)!.calls, [{ name: "bash", arguments: { command: "pwd" } }]);
});

test("fenced bash only counts in text-protocol mode", () => {
  const text = "Run this:\n```bash\necho hi\n```";
  assert.equal(parseTextToolCalls(text, TOOLS), null);
  assert.deepEqual(parseTextToolCalls(text, TOOLS, { fencedBash: true })!.calls, [{ name: "bash", arguments: { command: "echo hi" } }]);
});

test("unknown tools and plain prose are not calls", () => {
  assert.equal(parseTextToolCalls('<tool_call>{"name":"rm_rf","arguments":{}}</tool_call>', TOOLS), null);
  assert.equal(parseTextToolCalls("The answer is {not json}.", TOOLS), null);
  assert.equal(parseTextToolCalls('{"answer": 42}', TOOLS), null);
});

function message(text: string, extra: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text }],
    api: "openai-completions",
    provider: "omlx",
    model: "m",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: 0,
    ...extra,
  } as AssistantMessage;
}

test("repairMessage keeps thinking, strips markup, sets toolUse", () => {
  const r = repairMessage(message('ok <tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>'), TOOLS, { idPrefix: "c1" })!;
  assert.equal(r.message.stopReason, "toolUse");
  assert.deepEqual(r.message.content.map((c) => c.type), ["thinking", "text", "toolCall"]);
  const call = r.message.content[2] as { id: string; name: string; arguments: unknown };
  assert.equal(call.name, "bash");
  assert.match(call.id, /^c1_/);
  assert.equal(r.info.calls.length, 1);
  assert.equal(repairMessage(message("no calls here"), TOOLS), null);
});

test("stream wrapper replaces the final message and reports the repair; skips length stops", async () => {
  const run = async (msg: AssistantMessage, reason: "stop" | "length") => {
    const src = createAssistantMessageEventStream();
    const repairs: unknown[] = [];
    const out = withTextToolCallFallback(src, () => TOOLS, { onRepair: (r) => repairs.push(r) });
    src.push({ type: "start", partial: msg });
    src.push({ type: "done", reason, message: msg } as any);
    src.end();
    const final = await out.result();
    return { final, repairs };
  };
  const a = await run(message('<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>'), "stop");
  assert.equal(a.final.stopReason, "toolUse");
  assert.equal(a.repairs.length, 1);
  const b = await run(message('<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>', { stopReason: "length" }), "length");
  assert.equal(b.final.stopReason, "length");
  assert.equal(b.repairs.length, 0);
});

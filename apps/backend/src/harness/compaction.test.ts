import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { rawEstimate } from "./budget.ts";
import { compact, headTail } from "./compaction.ts";

const sys = { role: "system", content: "You are an agent.", timestamp: 0 } as AgentMessage;
const user = (text: string) => ({ role: "user", content: text, timestamp: 0 }) as AgentMessage;
const call = (id: string, cmd: string) =>
  ({ role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command: cmd } }], api: "openai-completions", provider: "omlx", model: "m", usage: {} as any, stopReason: "toolUse", timestamp: 0 }) as AgentMessage;
const result = (id: string, text: string) => ({ role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text }], isError: false, timestamp: 0 }) as AgentMessage;
const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} line ${i} ${"x".repeat(40)}`).join("\n");

function transcript(steps: number, outLines: number): AgentMessage[] {
  const m: AgentMessage[] = [sys, user("Fix the build.")];
  for (let i = 0; i < steps; i++) m.push(call(`c${i}`, `step ${i}`), result(`c${i}`, lines(outLines, `s${i}`)));
  return m;
}

test("headTail keeps first and last lines with a marker", () => {
  const r = headTail(lines(100, "a"), 5);
  assert.equal(r.cut, true);
  const out = r.text.split("\n");
  assert.equal(out.length, 11);
  assert.match(out[5], /90 lines removed/);
  assert.equal(headTail("short", 5).cut, false);
});

test("under the limit nothing changes", () => {
  const m = transcript(2, 5);
  const r = compact(m, { window: 32768, outputBudget: 4096, estimate: rawEstimate });
  assert.equal(r.messages, m);
  assert.equal(r.removedTurns, 0);
  assert.equal(r.truncatedResults, 0);
});

test("step 1: old tool outputs are shortened, recent ones kept", () => {
  const m = transcript(4, 120);
  const before = rawEstimate(m);
  const r = compact(m, { window: before + 600, outputBudget: 1024, estimate: rawEstimate });
  assert.equal(r.removedTurns, 0);
  assert.equal(r.truncatedResults, 2);
  assert.ok(r.afterTokens < before);
  const texts = r.messages.filter((x) => x.role === "toolResult").map((x: any) => x.content[0].text as string);
  assert.match(texts[0], /lines removed by the harness/);
  assert.doesNotMatch(texts[3], /lines removed/);
});

test("step 2: oldest turns dropped, task kept with a cumulative note, fits the window", () => {
  const m = transcript(12, 60);
  const opts = { window: 4096, outputBudget: 1024, estimate: rawEstimate, filesChanged: () => ["app.py", "test_app.py"] };
  const r = compact(m, opts);
  assert.ok(r.removedTurns > 0);
  assert.ok(r.afterTokens <= 4096 - 1024 - 256, `after ${r.afterTokens}`);
  assert.equal(r.messages[0], sys);
  const task = r.messages[1] as any;
  const text = task.content[0].text as string;
  assert.match(text, /^Fix the build\./);
  assert.match(text, new RegExp(`\\[harness: ${r.removedTurns} earlier steps removed to fit the context window; files changed so far: app.py, test_app.py\\]$`));
  // Every remaining tool result still follows its call.
  const ids = new Set(r.messages.filter((x) => x.role === "assistant").flatMap((x: any) => x.content.map((c: any) => c.id)));
  for (const x of r.messages) if (x.role === "toolResult") assert.ok(ids.has((x as any).toolCallId));
  // Compacting again later adds to the count instead of stacking notes.
  const grown = [...r.messages, ...transcript(8, 60).slice(2)];
  const r2 = compact(grown, opts);
  const text2 = (r2.messages[1] as any).content[0].text as string;
  assert.equal(text2.match(/\[harness:/g)?.length, 1);
  assert.match(text2, new RegExp(`\\[harness: ${r.removedTurns + r2.removedTurns} earlier steps`));
});

test("deterministic: same input, same output", () => {
  const m = transcript(10, 80);
  const a = compact(m, { window: 4096, outputBudget: 1024, estimate: rawEstimate });
  const b = compact(m, { window: 4096, outputBudget: 1024, estimate: rawEstimate });
  assert.deepEqual(a.messages, b.messages);
});

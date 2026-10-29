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

/** A "tokenizer" that counts like a dense-text model: one token per 2 characters of every text field. */
const denseText = (t: string) => Math.ceil(t.length / 2);
const dense = (msgs: AgentMessage[]) => msgs.reduce((n, m: any) => n + 4 + denseText(typeof m.content === "string" ? m.content : JSON.stringify(m.content)), 0);

test("headTail keeps first and last lines with a marker", () => {
  const r = headTail(lines(100, "a"), 5);
  assert.equal(r.cut, true);
  const out = r.text.split("\n");
  assert.equal(out.length, 11);
  assert.match(out[5], /90 lines removed/);
  assert.equal(headTail("short", 5).cut, false);
});

test("under the limit nothing changes", async () => {
  const m = transcript(2, 5);
  const r = await compact(m, { window: 32768, outputBudget: 4096, count: rawEstimate });
  assert.equal(r.messages, m);
  assert.equal(r.removedTurns, 0);
  assert.equal(r.truncatedResults, 0);
  assert.equal(r.fits, true);
});

test("step 1: old tool outputs are shortened, recent ones kept", async () => {
  const m = transcript(4, 120);
  const before = rawEstimate(m);
  const r = await compact(m, { window: before + 600, outputBudget: 1024, count: rawEstimate });
  assert.equal(r.removedTurns, 0);
  assert.equal(r.truncatedResults, 2);
  assert.ok(r.afterTokens < before);
  const texts = r.messages.filter((x) => x.role === "toolResult").map((x: any) => x.content[0].text as string);
  assert.match(texts[0], /lines removed by the harness/);
  assert.doesNotMatch(texts[3], /lines removed/);
});

test("step 2: oldest turns dropped, task kept with a cumulative note, fits the window", async () => {
  const m = transcript(12, 60);
  const opts = { window: 4096, outputBudget: 1024, count: rawEstimate, filesChanged: () => ["app.py", "test_app.py"] };
  const r = await compact(m, opts);
  assert.ok(r.removedTurns > 0);
  assert.ok(r.afterTokens <= 4096 - 1024 - 256, `after ${r.afterTokens}`);
  assert.equal(r.fits, true);
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
  const r2 = await compact(grown, opts);
  const text2 = (r2.messages[1] as any).content[0].text as string;
  assert.equal(text2.match(/\[harness:/g)?.length, 1);
  assert.match(text2, new RegExp(`\\[harness: ${r.removedTurns + r2.removedTurns} earlier steps`));
});

test("step 2 removes the fewest turns that fit (one fewer would not fit)", async () => {
  const m = transcript(30, 30);
  const counts: number[] = [];
  const count = (x: AgentMessage[]) => {
    const n = dense(x);
    counts.push(n);
    return n;
  };
  const r = await compact(m, { window: 8192, outputBudget: 1024, count, countText: denseText, keepRecentToolResults: 100 });
  const limit = 8192 - 1024 - 256;
  assert.equal(r.limit, limit);
  assert.ok(r.removedTurns > 0 && r.fits);
  assert.ok(r.afterTokens <= limit);
  // The same prompt with one fewer step removed (every step is [call, result] after the task) is over the limit.
  const k = r.removedTurns;
  const noted = { ...(m[1] as any), content: [{ type: "text", text: `Fix the build.\n\n[harness: ${k - 1} earlier step${k - 1 === 1 ? "" : "s"} removed to fit the context window]` }] };
  assert.ok(dense([sys, noted, ...m.slice(2 + 2 * (k - 1))]) > limit);
  // Bisection: far fewer counts than removed turns (a linear scan would count k + 2 times).
  assert.ok(counts.length < 10 && counts.length < k, `${counts.length} counts for ${k} removals`);
});

test("step 3: a single tool output bigger than the window is shortened with a marker giving the numbers", async () => {
  const huge = Array.from({ length: 3000 }, (_, i) => `row ${i} ${"7".repeat(20)}`).join("\n"); // ~43K chars, ~21.6K dense tokens
  const m: AgentMessage[] = [sys, user("Print the table."), call("c0", "cat table.txt"), result("c0", huge)];
  const saved: { id: string; text: string }[] = [];
  const r = await compact(m, {
    window: 8192,
    outputBudget: 1024,
    count: dense,
    countText: denseText,
    saveOriginal: (id, text) => {
      saved.push({ id, text });
      return "f".repeat(64);
    },
  });
  assert.equal(r.fits, true, `after ${r.afterTokens} > ${r.limit}`);
  assert.ok(r.afterTokens <= 8192 - 1024 - 256);
  assert.equal(r.shortened.length, 1);
  const s = r.shortened[0];
  assert.equal(s.toolCallId, "c0");
  assert.equal(s.total, denseText(huge));
  assert.ok(s.keptHead > 0 && s.keptTail > 0);
  assert.equal(s.originalBlob, "f".repeat(64));
  assert.deepEqual(saved, [{ id: "c0", text: huge }]);
  const text = (r.messages[3] as any).content[0].text as string;
  assert.match(text, new RegExp(`\\[tool output shortened by the harness to fit the context window: kept the first ${s.keptHead} and last ${s.keptTail} of ${s.total} tokens\\]`));
  assert.ok(text.startsWith("row 0 "));
  assert.ok(text.endsWith(huge.slice(-200)));
  assert.match(r.note, /1 tool output shortened/);
  // The instruction and the call are untouched.
  assert.equal(r.messages[1], m[1]);
  assert.equal(r.messages[2], m[2]);

  // Shortening again later (window shrank) keeps the original total and doesn't stack markers.
  const r2 = await compact(r.messages, { window: 4096, outputBudget: 1024, count: dense, countText: denseText });
  const text2 = (r2.messages[3] as any).content[0].text as string;
  assert.equal(text2.match(/tool output shortened/g)?.length, 1);
  assert.equal(r2.shortened[0].total, s.total);
  assert.ok(r2.shortened[0].keptHead < s.keptHead);
  assert.ok(r2.fits);
});

test("step 3 never splits a surrogate pair", async () => {
  const emoji = "\u{1F600}".repeat(9000);
  const m: AgentMessage[] = [sys, user("go"), call("c0", "x"), result("c0", emoji)];
  const r = await compact(m, { window: 4096, outputBudget: 512, count: dense, countText: denseText });
  const text = (r.messages[3] as any).content[0].text as string;
  assert.ok(r.shortened.length === 1);
  assert.equal(text.isWellFormed(), true);
});

test("an instruction too big for the window can't be compacted: fits is false and nothing is invented", async () => {
  const m: AgentMessage[] = [sys, ...transcript(3, 10).slice(1), user("x".repeat(40000))];
  const r = await compact(m, { window: 8192, outputBudget: 1024, count: dense, countText: denseText });
  assert.equal(r.fits, false);
  assert.ok(r.afterTokens > r.limit);
  assert.ok(r.afterTokens > 8192);
  // The instruction is kept whole.
  const last = r.messages.findLast((x) => x.role === "user") as any;
  const lastText = typeof last.content === "string" ? last.content : last.content[0].text;
  assert.ok(lastText.startsWith("x".repeat(40000)));
});

test("multi-run session: earlier exchanges go first, the current instruction and newest step stay", async () => {
  const m: AgentMessage[] = [...transcript(6, 60), user("Now add tests."), call("n0", "new 0"), result("n0", lines(60, "n0")), call("n1", "new 1"), result("n1", lines(60, "n1"))];
  const r = await compact(m, { window: 4096, outputBudget: 1024, count: rawEstimate });
  assert.ok(r.removedTurns > 0);
  const texts = r.messages.map((x: any) => (typeof x.content === "string" ? x.content : (x.content?.[0]?.text ?? x.content?.[0]?.id ?? "")));
  const cur = r.messages.findIndex((x: any) => x.role === "user" && JSON.stringify(x.content).includes("Now add tests."));
  assert.ok(cur > 0, "current instruction kept");
  assert.match(texts[cur], /\[harness: \d+ earlier steps? removed/);
  assert.equal((r.messages.at(-1) as any).toolCallId, "n1", "newest step kept");
  // The old run is dropped before any step of the current run.
  const keptNew = r.messages.filter((x: any) => x.role === "toolResult" && x.toolCallId.startsWith("n")).length;
  const keptOld = r.messages.filter((x: any) => x.role === "toolResult" && x.toolCallId.startsWith("c")).length;
  assert.ok(keptOld === 0 || keptNew === 2, `old ${keptOld}, new ${keptNew}`);
});

test("deterministic: same input, same output", async () => {
  const m = transcript(10, 80);
  const a = await compact(m, { window: 4096, outputBudget: 1024, count: rawEstimate });
  const b = await compact(m, { window: 4096, outputBudget: 1024, count: rawEstimate });
  assert.deepEqual(a.messages, b.messages);
});

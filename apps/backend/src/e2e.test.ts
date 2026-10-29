// End-to-end: real oMLX + Qwen3.5-4B, terrarium harness, simulated env. Run with `pnpm test:e2e`
// (TERRARIUM_E2E=1). Uses a temp data dir; loads one model and stops oMLX at the end.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TraceEvent } from "@terrarium/shared";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";

const MODEL = process.env.TERRARIUM_E2E_MODEL ?? "Qwen3.5-4B-MLX-4bit";
const WINDOW = 8192;

test("e2e: multi-step python task in a sim env, then a long session", { skip: process.env.TERRARIUM_E2E !== "1", timeout: 60 * 60 * 1000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "terrarium-e2e-"));
  const config = loadConfig({ ...process.env, TERRARIUM_DATA: dataDir, TERRARIUM_TOKEN: "e2e" });
  const app = await createApp(config);
  const events: TraceEvent[] = [];
  app.hub.listen((m) => {
    if (m.type === "trace" && m.event.type !== "model_delta" && m.event.type !== "tool_output") events.push(m.event);
  });
  try {
    const env = await app.envs.create({
      name: "e2e",
      type: "sim",
      seedFiles: [{ path: "/workspace/numbers.txt", content: "values\n3\n5\n\n10\n" }],
    });
    const thinking = process.env.TERRARIUM_E2E_THINKING === undefined ? undefined : process.env.TERRARIUM_E2E_THINKING === "1";
    const s = await app.sessions.create({ envId: env.id, modelId: MODEL, harness: "terrarium", contextWindow: WINDOW, ...(thinking !== undefined ? { thinking } : {}) });
    assert.equal(s.contextWindow, WINDOW);

    const t0 = Date.now();
    const first = await app.sessions.run(
      s.id,
      "Write /workspace/avg.py that prints the average of the numbers in /workspace/numbers.txt (one number per line). Run it with python3 and fix any error until it prints the right answer.",
      { maxTurns: 15 },
    );
    const firstMs = Date.now() - t0;
    const tools = events.filter((e) => e.type === "tool_end");
    const fs = events.filter((e) => e.type === "fs_change").flatMap((e) => (e.type === "fs_change" ? e.changes : []));
    assert.equal(first.reason, "done", `first run ended: ${first.reason} ${first.error ?? ""}`);
    assert.ok(tools.length >= 2, `expected >= 2 tool calls, got ${tools.length}`);
    assert.ok(fs.some((c) => c.path === "/workspace/avg.py" && c.diffBlob), "avg.py change with a diff");
    const out = await app.envs.exec(env.id, { command: "python3 avg.py", as: "agent" });
    assert.match(out.stdout, /\b6(\.0+)?\b/, `avg.py output: ${out.stdout} ${out.stderr}`);

    // Long session: keep going in the same 8K window. Every call must get a real output budget and real replies.
    const follow = [
      "Change avg.py to also print the minimum and maximum, one per line after the average. Run it.",
      "Add a short module docstring and a main() function to avg.py, keep the behaviour the same, and run it again.",
      "Write /workspace/test_avg.py with two small checks of your functions using assert, and run it with python3.",
      "Show me the final avg.py with cat, then summarize what you changed in two sentences.",
    ];
    const reasons: string[] = [];
    for (const text of follow) reasons.push((await app.sessions.run(s.id, text, { maxTurns: 15 })).reason);

    const starts = events.filter((e) => e.type === "model_call_start");
    const ends = events.filter((e) => e.type === "model_call_end");
    const compactions = events.filter((e) => e.type === "compaction");
    const repairs = events.filter((e) => e.type === "harness_repair");
    const warnings = events.filter((e) => e.type === "warning");
    const maxPrompt = Math.max(...ends.map((e) => (e.type === "model_call_end" ? (e.usage?.promptTokens ?? 0) : 0)));
    const minBudget = Math.min(...starts.map((e) => (e.type === "model_call_start" ? e.maxTokens : Infinity)));
    const oneToken = ends.filter((e) => e.type === "model_call_end" && e.finishReason !== "aborted" && (e.usage?.completionTokens ?? 0) <= 1);

    const counts: Record<string, number> = {};
    for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;
    const lines = [
      `model ${MODEL}, window ${WINDOW}, thinking ${s.thinking}, session maxOutput ${s.maxOutputTokens}`,
      `first run: ${first.reason} in ${Math.round(firstMs / 1000)} s, ${tools.length} tool calls; avg.py prints ${JSON.stringify(out.stdout.trim())}`,
      `follow-up runs: ${reasons.join(", ")}`,
      `model calls: ${ends.length}; max prompt ${maxPrompt} tokens; min max_tokens sent ${minBudget}; one-token replies ${oneToken.length}`,
      `compactions ${compactions.length}; harness repairs ${repairs.length}; warnings ${warnings.map((w) => (w.type === "warning" ? w.code : "")).join(",") || "none"}`,
      `event counts: ${JSON.stringify(counts)}`,
      "first 40 events:",
      ...events.slice(0, 40).map((e) => {
        const x = e as any;
        const info =
          e.type === "tool_start" ? `${x.name} ${JSON.stringify(x.args).slice(0, 80)}`
          : e.type === "tool_end" ? `${x.name} exit=${x.exitCode ?? "-"} ${x.durationMs}ms files=${x.fileChanges}`
          : e.type === "model_call_start" ? `est=${x.promptTokensEst} max_tokens=${x.maxTokens}`
          : e.type === "model_call_end" ? `${x.finishReason} prompt=${x.usage?.promptTokens} out=${x.usage?.completionTokens} ttft=${Math.round(x.timing?.ttftMs ?? 0)}ms gen=${x.timing?.genTps?.toFixed?.(1)}tok/s`
          : e.type === "assistant_message" ? `text=${JSON.stringify(x.text).slice(0, 60)} calls=${x.toolCalls.length}`
          : e.type === "fs_change" ? x.changes.map((c: any) => `${c.kind} ${c.path}`).join("; ")
          : e.type === "context" ? `prompt+hist=${x.usage.systemAndTools + x.usage.history} free=${x.usage.free} (${x.usage.source})`
          : e.type === "user_message" ? JSON.stringify(x.text).slice(0, 60)
          : e.type === "run_end" ? x.reason
          : e.type === "warning" ? `${x.code}: ${x.message}`
          : "";
        return `  ${e.seq} ${e.type} ${info}`;
      }),
    ];
    writeFileSync(process.env.TERRARIUM_E2E_REPORT ?? join(tmpdir(), "terrarium-e2e-report.txt"), `${lines.join("\n")}\n`);
    console.log(lines.slice(0, 6).join("\n"));

    const req = app.store.get<{ request_blob: string }>("SELECT request_blob FROM model_calls WHERE session_id = ? ORDER BY seq DESC LIMIT 1", s.id);
    const body = app.store.blobs.getJson<Record<string, any>>(req!.request_blob)!;
    assert.equal(body.chat_template_kwargs?.enable_thinking, s.thinking);
    assert.ok(body.max_tokens >= 512, `last request max_tokens ${body.max_tokens}`);
    assert.equal(oneToken.length, 0, "no one-token replies");
    assert.ok(minBudget >= 512, `smallest output budget sent was ${minBudget}`);
    assert.ok(reasons.every((r) => r === "done" || r === "max_turns"), `follow-up reasons ${reasons}`);
  } finally {
    await app.inference.unload(MODEL).catch(() => undefined);
    await app.shutdown();
    if (process.env.TERRARIUM_E2E_KEEP === "1") console.log(`kept data dir ${dataDir}`);
    else rmSync(dataDir, { recursive: true, force: true });
  }
});

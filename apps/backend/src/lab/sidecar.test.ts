// The real sidecar (scripts/lab_serve.py) through the real supervisor, on a tiny random-weight Qwen3.5 built for the
// test (scripts/lab_tiny_model.py, tokenizer from models/Qwen3.5-4B-MLX-4bit): the key and Host gate, load facts,
// every Lab op, strain registration, the OpenAI-compatible chat (JSON and SSE) and tokenizer, and exit on stdin EOF.
// Skipped without the repo .venv or that model dir.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { BACKEND_DIR, REPO_DIR } from "../config.ts";
import { type LabHealth, LabSidecar, SidecarError } from "./sidecar.ts";

const PY = join(REPO_DIR, ".venv", "bin", "python");
const TOKENIZER = join(REPO_DIR, "models", "Qwen3.5-4B-MLX-4bit");
const skip = !existsSync(PY) || !existsSync(join(TOKENIZER, "tokenizer.json")) ? "needs the repo .venv and models/Qwen3.5-4B-MLX-4bit (for its tokenizer)" : false;

let dir: string;
let lab: LabSidecar;
let health: LabHealth;

before(async () => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), "terrarium-labpy-"));
  execFileSync(PY, ["-I", join(BACKEND_DIR, "scripts", "lab_tiny_model.py"), join(dir, "models", "tiny"), TOKENIZER], { stdio: "pipe", timeout: 120_000 });
  lab = new LabSidecar({ modelId: "tiny", venvDir: join(REPO_DIR, ".venv"), modelsDir: join(dir, "models"), dataDir: join(dir, "lab") });
  await lab.spawn();
  const end = Date.now() + 120_000;
  for (;;) {
    health = await lab.health().catch(() => health);
    if (health?.status === "ready" || health?.status === "error") break;
    if (Date.now() > end) throw new Error("tiny model did not load");
    await new Promise((r) => setTimeout(r, 200));
  }
});

after(async () => {
  if (skip) return;
  await lab?.stop();
  rmSync(dir, { recursive: true, force: true });
});

function raw(path: string, headers: Record<string, string>): Promise<number> {
  const port = Number(new URL(lab.baseUrl).port);
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, path, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    r.on("error", reject);
    r.end();
  });
}

test("gate: key and Host", { skip }, async () => {
  const port = new URL(lab.baseUrl).port;
  assert.equal(await raw("/health", { Host: `127.0.0.1:${port}` }), 401);
  assert.equal(await raw("/health", { Host: `127.0.0.1:${port}`, Authorization: "Bearer nope" }), 401);
  assert.equal(await raw("/health", { Host: `evil.example:${port}`, Authorization: `Bearer ${lab.key}` }), 403);
  assert.equal(await raw("/health", { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${lab.key}` }), 200);
});

test("load facts", { skip }, () => {
  assert.equal(health.status, "ready", health.detail);
  const f = health.facts!;
  assert.match(f.arch, /^qwen3_5/);
  assert.equal(f.layers, 4);
  assert.deepEqual(f.neuronsPerLayer, [128, 128, 128, 128]);
  assert.deepEqual(f.layerKinds, ["linear", "linear", "linear", "full"]);
  assert.equal(f.residNorm.length, 4);
  assert.ok(f.calibrationTokens > 1000, "calibrated on the field guide");
});

test("probe, neuron card, find", { skip }, async () => {
  const p = await lab.request<any>("POST", "/probe", { text: "The owl flew over the barn.", watch: [{ layer: 1, neuron: 3 }], layer: 2, top: 10 });
  assert.ok(p.tokens.length > 4);
  assert.equal(p.tokens[0].kind, "template", "the leading newline the Lab adds");
  assert.ok(p.tokens.slice(1).every((t: any) => t.kind === "text"));
  assert.equal(p.top.length, 10);
  assert.equal(p.watch[0].values.length, p.tokens.length);
  assert.equal(p.layer.layer, 2);
  const chat = await lab.request<any>("POST", "/probe", { text: "Hi", chat: true, reply: true, maxTokens: 4 });
  assert.ok(chat.tokens.some((t: any) => t.kind === "template") && chat.tokens.some((t: any) => t.kind === "reply"));

  const card = await lab.request<any>("POST", "/neuron", { layer: 3, neuron: 7 });
  assert.equal(card.promotes.length > 0 && card.suppresses.length > 0, true);
  assert.ok(card.doseUnit > 0 && card.firesOn.length > 0);

  const f = await lab.request<any>("POST", "/find", { concept: ["An owl hooted.", "The owl hunted mice.", "Owls see at night."], control: ["A car drove by.", "The bread was warm.", "Rain fell all day."], top: 5, previews: 1, prompt: "Who are you?" });
  assert.ok(f.candidates.length >= 5);
  const c = f.candidates[0];
  for (const k of ["score", "conceptMean", "controlMean", "beatsAll", "typical", "promotes", "snippets", "writes", "both"]) assert.ok(k in c, `candidate has ${k}`);
  assert.ok(f.candidates.filter((x: any) => x.preview).length === 1, "one steered preview");
  await assert.rejects(lab.request("POST", "/find", { concept: ["a"], control: ["b"] }), (e: SidecarError) => e.status === 400 && /at least 2/.test(e.message));
  await assert.rejects(lab.request("POST", "/probe", { text: "x", watch: [{ layer: 9, neuron: 0 }] }), (e: SidecarError) => e.status === 400);
});

test("generate, sweep, attribute", { skip }, async () => {
  const mix = Array.from({ length: 16 }, (_, i) => ({ layer: 3, neuron: i, mode: "dose", value: 20 }));
  const g = await lab.request<any>("POST", "/generate", { prompt: "Who are you?", mix, temperature: 0, maxTokens: 8, baseline: true });
  assert.ok(g.steered.tokens > 0 && g.baseline.tokens > 0);
  assert.notEqual(g.steered.text, g.baseline.text, "a big push changes the reply");
  assert.ok(Number.isFinite(g.steered.fluency));
  const s = await lab.request<any>("POST", "/sweep", { prompt: "Who are you?", mix: mix.slice(0, 1), target: { layer: 3, neuron: 0 }, doses: [0, 30], temperature: 0, maxTokens: 6 });
  assert.deepEqual(s.rows.map((r: any) => r.dose), [0, 30]);
  const a = await lab.request<any>("POST", "/attribute", { prompt: "Who are you?", prefill: "I am", target: " a", top: 5 });
  assert.equal(a.nodes.length, 5);
  assert.ok(a.peakBytes > 0 && typeof a.metric === "number");
});

test("strains and the OpenAI-compatible endpoint", { skip }, async () => {
  await assert.rejects(lab.request("PUT", "/strains/s1", { pushes: [{ layer: 99, neuron: 0, mode: "dose", value: 1 }] }), (e: SidecarError) => e.status === 400);
  await lab.request("PUT", "/strains/s1", { pushes: [{ layer: 2, neuron: 5, mode: "dose", value: 2 }] });
  assert.deepEqual((await lab.health()).strains, ["s1"]);

  const messages = [{ role: "user", content: "Who are you?" }];
  const j = await lab.request<any>("POST", "/v1/chat/completions", { model: "strain:s1", messages, max_tokens: 6, temperature: 0, chat_template_kwargs: { enable_thinking: false } });
  assert.equal(j.object, "chat.completion");
  assert.ok(j.choices[0].finish_reason === "length" || j.choices[0].finish_reason === "stop");
  assert.ok(j.usage.prompt_tokens > 0 && j.usage.completion_tokens > 0);
  await assert.rejects(lab.request("POST", "/v1/chat/completions", { model: "strain:nope", messages }), (e: SidecarError) => e.status === 400 && /not registered/.test(e.message));

  const res = await fetch(`${lab.baseUrl}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${lab.key}`, "content-type": "application/json" }, body: JSON.stringify({ model: "strain:s1", messages, max_tokens: 6, temperature: 0, stream: true, stream_options: { include_usage: true }, chat_template_kwargs: { enable_thinking: false } }) });
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const lines = (await res.text()).split("\n").filter((l) => l.startsWith("data: "));
  assert.equal(lines.at(-1), "data: [DONE]");
  const chunks = lines.slice(0, -1).map((l) => JSON.parse(l.slice(6)));
  assert.ok(chunks.some((c) => c.choices?.[0]?.finish_reason));
  const usage = chunks.find((c) => c.usage)?.usage;
  assert.ok(usage && typeof usage.time_to_first_token === "number" && usage.generation_tokens_per_second > 0, "usage carries the timing the gateway reads");

  const t = await lab.request<any>("POST", "/v1/tokenize", { model: "strain:s1", messages, add_generation_prompt: true });
  assert.ok(t.count > 3);
  const t2 = await lab.request<any>("POST", "/v1/tokenize", { model: "strain:s1", prompt: "hello world", add_special_tokens: false });
  assert.equal(t2.count, 2);
});

test("exits when its stdin closes (the backend died)", { skip }, async () => {
  const other = new LabSidecar({ modelId: "tiny", venvDir: join(REPO_DIR, ".venv"), modelsDir: join(dir, "models"), dataDir: join(dir, "lab") });
  let exited = false;
  other.onExit = () => (exited = true);
  await other.spawn();
  (other as unknown as { child: { stdin: { end(): void } } }).child.stdin.end();
  const end = Date.now() + 10_000;
  while (!exited && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  assert.ok(exited, "process exited on EOF");
});

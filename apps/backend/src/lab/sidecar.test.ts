// The real sidecar (scripts/lab_serve.py) through the real supervisor, on a tiny random-weight Qwen3.5 built for the
// test (scripts/lab_tiny_model.py, tokenizer from models/Qwen3.5-4B-MLX-4bit): the key and Host gate, load facts,
// every Lab op, measured Trace rows, cancel, strain registration, the OpenAI-compatible chat (JSON and SSE) and
// tokenizer, and exit on stdin EOF. A tiny LFM3 covers the other MLP shape.
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

const LFM_TOKENIZER = join(REPO_DIR, "models", "LFM3-1.7B-MLX-8bit");
const lfmSkip = skip || !existsSync(join(LFM_TOKENIZER, "tokenizer.json")) ? "needs the repo .venv and models/LFM3-1.7B-MLX-8bit (for its tokenizer)" : false;

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
  assert.equal(f.tryDose, 0.8);
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

test("trace: each row's dose comes from really pushing that neuron", { skip }, async () => {
  const req = { prompt: "Who are you?", prefill: "I am", target: " a", foil: " the", doses: [0.5, 2] };
  const a = await lab.request<any>("POST", "/attribute", { ...req, top: 8 });
  assert.equal(a.measure.passes, a.measure.neurons * 4, "both signs of both sizes, per neuron");
  assert.deepEqual(a.measure.doses, [0.5, -0.5, 2, -2]);
  for (const n of a.nodes.filter((x: any) => x.best)) {
    const moved = n.measured.filter((m: any) => m.top === " a").sort((x: any, y: any) => Math.abs(x.dose) - Math.abs(y.dose));
    if (moved.length) {
      assert.ok(n.best.flips, "a dose that makes the target the pick is what's offered");
      assert.equal(Math.abs(n.best.dose), Math.abs(moved[0].dose), "the smallest one");
    } else {
      assert.equal(n.best.metric, Math.max(...n.measured.map((m: any) => m.metric)), "else the sign and size that moved it most, not attr's sign");
    }
    assert.ok(Math.abs(n.best.metric - a.metric - n.best.change) < 0.01);
  }
  // Nothing about the row is an estimate: the same dose, run as a mix, gives the same gap and the same pick.
  const top = a.nodes[0];
  const again = await lab.request<any>("POST", "/attribute", { ...req, top: 1, measure: false, mix: [{ layer: top.layer, neuron: top.neuron, mode: "dose", value: top.best.dose }] });
  assert.ok(Math.abs(again.metric - top.best.metric) < 0.05, `${again.metric} vs ${top.best.metric}`);
  assert.equal(again.top, top.best.top);
  // A dose already in the mix counts: the new one replaces it, and the row says what it held.
  const held = await lab.request<any>("POST", "/attribute", { ...req, top: 8, shortlist: 8, mix: [{ layer: top.layer, neuron: top.neuron, mode: "dose", value: 0.5 }] });
  const same = held.nodes.find((n: any) => n.layer === top.layer && n.neuron === top.neuron);
  if (same) assert.equal(same.held, 0.5);
});

test("trace: fields that aren't one token say so", { skip }, async () => {
  const t = await lab.request<any>("POST", "/tokens", { texts: ["**Qwen", " a"] });
  assert.ok(t.tokens[0].length > 1);
  assert.equal(t.tokens[0].map((x: any) => x.text).join(""), "**Qwen");
  assert.equal(t.tokens[1].length, 1);
  const a = await lab.request<any>("POST", "/attribute", { prompt: "Who are you?", prefill: "I am ", target: "**Qwen", top: 2, measure: false });
  assert.equal(a.target, ` ${t.tokens[0][0].text}`, "first token, with a note, and the prefill's space");
  assert.ok(a.notes.some((n: string) => n.includes("**Qwen")));
  assert.ok(a.notes.some((n: string) => /space/.test(n)), "the trailing space is moved, and that's said");
  assert.equal(a.prefill, "I am");
  const u = await lab.request<any>("POST", "/attribute", { prompt: "Who are you?", prefill: "I am", target: " a", foilFrom: "unsteered", mix: [{ layer: 2, neuron: 1, mode: "dose", value: 1 }], top: 2, measure: false });
  assert.ok(u.foil.length > 0, "the foil is what the model writes here without the mix");
  await assert.rejects(lab.request("POST", "/tokens", {}), SidecarError);
});

test("replies: pieces, quality, repeat penalty", { skip }, async () => {
  const req = { prompt: "Who are you?", temperature: 0, maxTokens: 24, seed: 1 };
  const off = (await lab.request<any>("POST", "/generate", req)).steered;
  assert.equal(off.pieces.join(""), off.text, "cut at token boundaries, nothing lost");
  assert.ok(["ok", "odd", "loop", "broken", "empty"].includes(off.quality));
  assert.equal(typeof off.loop, "boolean");
  const on = (await lab.request<any>("POST", "/generate", { ...req, repeat: 1.5 })).steered;
  assert.notDeepEqual(on.pieces, off.pieces, "a penalty changes what's picked");
  assert.ok(new Set(on.pieces).size >= new Set(off.pieces).size);
});

test("a sweep keeps close doses apart and takes many", { skip }, async () => {
  const doses = Array.from({ length: 200 }, (_, i) => -1 + i * 0.01);
  const s = await lab.request<any>("POST", "/sweep", { prompt: "Hi", mix: [{ layer: 3, neuron: 0, mode: "dose", value: 1 }], target: { layer: 3, neuron: 0 }, doses: [...doses, doses[0]], temperature: 0, maxTokens: 1 });
  assert.equal(s.rows.length, 200, "no cap at 16; duplicates go");
  assert.ok(Math.abs(s.rows[1].dose - s.rows[0].dose - 0.01) < 1e-6);
});

test("cancel stops the op that runs, and the next one is fine", { skip }, async () => {
  const running = lab.request<any>("POST", "/generate", { prompt: "Who are you?", temperature: 0, maxTokens: 4000 });
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(await lab.request("POST", "/cancel", {}), { ok: true, busy: "generate" });
  await assert.rejects(running, /cancelled/);
  const after = await lab.request<any>("POST", "/generate", { prompt: "Hi", temperature: 0, maxTokens: 2 });
  assert.ok(after.steered.tokens > 0);
});

test("Surprise me and described traits", { skip }, async () => {
  const x = await lab.request<any>("POST", "/explore", { sample: 6, top: 2, seed: 3 });
  assert.equal(x.sampled, 6);
  assert.equal(x.picks.length, 2);
  assert.ok(x.picks.every((p: any) => p.layer === x.layer && p.kl >= 0));
  await assert.rejects(lab.request("POST", "/examples", { trait: "  " }), /describe a trait/);
  // A random-weight model can't write examples, and says what to do instead.
  await assert.rejects(lab.request("POST", "/examples", { trait: "a tiger", n: 4, seed: 1 }), /Use your own texts/);
});

test("LFM3: the hooks wrap feed_forward.w2, and a batch of doses matches one at a time", { skip: lfmSkip }, async () => {
  const d = mkdtempSync(join(tmpdir(), "terrarium-labpy-"));
  execFileSync(PY, ["-I", join(BACKEND_DIR, "scripts", "lab_tiny_model.py"), join(d, "models", "tiny-lfm"), LFM_TOKENIZER, "lfm3"], { stdio: "pipe", timeout: 120_000 });
  const l = new LabSidecar({ modelId: "tiny-lfm", venvDir: join(REPO_DIR, ".venv"), modelsDir: join(d, "models"), dataDir: join(d, "lab") });
  try {
    await l.spawn();
    const end = Date.now() + 120_000;
    let h: LabHealth | undefined;
    for (;;) {
      h = await l.health().catch(() => h);
      if (h?.status === "ready" || h?.status === "error") break;
      if (Date.now() > end) throw new Error("tiny LFM3 did not load");
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(h?.status, "ready", h?.detail);
    assert.deepEqual(h?.facts?.layerKinds, ["conv", "sliding", "full"]);
    assert.deepEqual(h?.facts?.neuronsPerLayer, [128, 128, 128]);
    assert.equal(h?.facts?.tryDose, 3, "its MLP output is renormalized, so a first try needs more");
    const p = await l.request<any>("POST", "/probe", { text: "The owl flew.", watch: [{ layer: 1, neuron: 3 }], layer: 1, top: 4 });
    assert.ok(p.tokens.length > 2);
    const f = await l.request<any>("POST", "/find", { concept: ["The owl hunts at night.", "An owl sat in the barn."], control: ["The dog runs at noon.", "A dog sat in the yard."], top: 3, previews: 1, testPrompt: "Hi" });
    assert.ok(f.candidates.length > 0);
    const mix = Array.from({ length: 16 }, (_, i) => ({ layer: 2, neuron: i, mode: "dose", value: 40 }));
    const g = await l.request<any>("POST", "/generate", { prompt: "Who are you?", mix, temperature: 0, maxTokens: 8, baseline: true });
    assert.notEqual(g.steered.text, g.baseline.text, "a big push changes the reply");
    const req = { prompt: "Who are you?", prefill: "I", target: " a", doses: [1] };
    const a = await l.request<any>("POST", "/attribute", { ...req, top: 6 });
    assert.ok(a.nodes.every((n: any) => n.layer <= 2));
    const top = a.nodes[0];
    const again = await l.request<any>("POST", "/attribute", { ...req, foil: a.foil, top: 1, measure: false, mix: [{ layer: top.layer, neuron: top.neuron, mode: "dose", value: top.best.dose }] });
    assert.ok(Math.abs(again.metric - top.best.metric) < 0.05, `${again.metric} vs ${top.best.metric}`);
    await l.request("PUT", "/strains/s1", { pushes: mix.slice(0, 2), name: "s1" });
    const chat = await l.request<any>("POST", "/v1/chat/completions", { model: "strain:s1", messages: [{ role: "user", content: "Hi" }], max_tokens: 3, temperature: 0 });
    assert.ok(chat.choices[0].message.content !== undefined);
  } finally {
    await l.stop();
    rmSync(d, { recursive: true, force: true });
  }
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

test("a strain registers while another request holds the model", { skip }, async () => {
  const doses = Array.from({ length: 16 }, (_, i) => i / 4);
  const slow = lab.request("POST", "/sweep", { prompt: "Who are you?", mix: [{ layer: 3, neuron: 0, mode: "dose", value: 1 }], target: { layer: 3, neuron: 0 }, doses, temperature: 1, seed: 1, maxTokens: 300 });
  for (let i = 0; (await lab.health()).busy !== "sweep"; i++) {
    assert.ok(i < 100, "sweep started");
    await new Promise((r) => setTimeout(r, 20));
  }
  await lab.request("PUT", "/strains/s2", { pushes: [{ layer: 1, neuron: 3, mode: "clamp", value: 4 }] }, 5_000);
  const h = await lab.health();
  assert.equal(h.busy, "sweep", "registered without waiting for the sweep");
  assert.ok(h.strains?.includes("s2"));
  await slow;
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

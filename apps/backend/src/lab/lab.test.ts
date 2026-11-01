// Lab routes against a fake sidecar (test-support/fake-lab.ts, same protocol as scripts/lab_serve.py): support
// list, the memory ceiling, load and ops, strains and probe sets, a strain serving a chat session, refusing to unload
// while it runs, a crash shown as an error, and shutdown stopping the process.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import type { LabState, LabStrain, ModelInfo, WsMessage } from "@terrarium/shared";
import { type App, createApp } from "../app.ts";
import { loadConfig } from "../config.ts";
import { estimateBytes } from "../inference/catalog.ts";
import { type ApiServer, createApiServer } from "../server/http.ts";

const FAKE = fileURLToPath(new URL("../test-support/fake-lab.ts", import.meta.url));
const TOKEN = "lab-test-token";

let dir: string;
let app: App;
let api: ApiServer;
let port: number;
let mode = "";
const sent: WsMessage[] = [];

function call<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const r = request({ host: "127.0.0.1", port, path, method, headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${TOKEN}`, ...(data ? { "content-type": "application/json" } : {}) } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : undefined }));
    });
    r.on("error", reject);
    r.end(data);
  });
}

async function until(what: string, fn: () => Promise<boolean> | boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const labState = async () => (await call<LabState>("GET", "/api/lab")).json;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "terrarium-lab-"));
  const models = join(dir, "models");
  mkdirSync(join(models, "tiny-qwen"), { recursive: true });
  writeFileSync(join(models, "tiny-qwen", "config.json"), JSON.stringify({ model_type: "qwen3_5", text_config: { model_type: "qwen3_5_text", num_hidden_layers: 4, intermediate_size: 85450 } }));
  writeFileSync(join(models, "tiny-qwen", "model.safetensors"), Buffer.alloc(1024));
  mkdirSync(join(models, "tiny-bonsai"), { recursive: true });
  writeFileSync(join(models, "tiny-bonsai", "config.json"), JSON.stringify({ model_type: "prism_hadamard_qwen35" }));
  mkdirSync(join(models, "tiny-moe"), { recursive: true });
  writeFileSync(join(models, "tiny-moe", "config.json"), JSON.stringify({ model_type: "moe", num_experts: 8 }));
  mkdirSync(join(models, "tiny-other"), { recursive: true });
  writeFileSync(join(models, "tiny-other", "config.json"), JSON.stringify({ model_type: "other", num_hidden_layers: 2 }));
  writeFileSync(join(models, "tiny-other", "model.safetensors.index.json"), JSON.stringify({ weight_map: { "model.layers.0.ffn.fc2.weight": "model.safetensors" } }));
  mkdirSync(join(models, "tiny-lfm"), { recursive: true });
  writeFileSync(join(models, "tiny-lfm", "config.json"), JSON.stringify({ model_type: "lfm3", num_hidden_layers: 2, intermediate_size: 64 }));
  writeFileSync(join(models, "tiny-lfm", "model.safetensors.index.json"), JSON.stringify({ weight_map: { "model.layers.0.feed_forward.w2.weight": "model.safetensors" } }));
  // Single-file weights: names come from the safetensors header.
  mkdirSync(join(models, "tiny-lfm-one"), { recursive: true });
  writeFileSync(join(models, "tiny-lfm-one", "config.json"), JSON.stringify({ model_type: "lfm3", num_hidden_layers: 2, intermediate_size: 64 }));
  const header = Buffer.from(JSON.stringify({ "model.layers.0.feed_forward.w2.weight": { dtype: "F32", shape: [1], data_offsets: [0, 4] } }));
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(header.length));
  writeFileSync(join(models, "tiny-lfm-one", "model.safetensors"), Buffer.concat([len, header, Buffer.alloc(4)]));
  app = await createApp(loadConfig({ ...process.env, TERRARIUM_DATA: join(dir, "data"), TERRARIUM_TOKEN: TOKEN, TERRARIUM_MODELS: models, TERRARIUM_VENV: join(dir, "no-venv") }));
  app.lab.command = (modelId) => ({ cmd: process.execPath, args: [FAKE, modelId, mode] });
  app.hub.listen((m) => sent.push(m));
  api = createApiServer(app);
  port = await api.listen(0);
});

after(async () => {
  await api.close();
  await app.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

test("support list and memory check", async () => {
  const s = await labState();
  assert.equal(s.status, "stopped");
  const qwen = s.support.find((x) => x.modelId === "tiny-qwen");
  assert.equal(qwen?.supported, true);
  // Bonsai's rotation is inside down_proj, after the hooks; LFM3's w2 is down_proj renamed.
  for (const id of ["tiny-bonsai", "tiny-lfm", "tiny-lfm-one"]) assert.equal(s.support.find((x) => x.modelId === id)?.supported, true, id);
  assert.match(s.support.find((x) => x.modelId === "tiny-moe")?.reason ?? "", /Mixture-of-experts/);
  assert.match(s.support.find((x) => x.modelId === "tiny-other")?.reason ?? "", /no gated MLP/);
  const m = (await call("GET", "/api/lab/memory?modelId=tiny-qwen")).json;
  assert.equal(m.fits, true);
  assert.equal(m.labBytes, 0);
  assert.ok(m.needBytes > 2e9, "weights plus the Lab's working memory");
  assert.equal((await call("GET", "/api/lab/memory?modelId=nope")).status, 404);
  // A running session's model that oMLX hasn't loaded yet counts at the session's window, as beforeOmlxLoad will.
  app.store.run("INSERT INTO sessions (id, title, model_id, harness, context_window, max_output_tokens, status, created_at, updated_at) VALUES ('s-mem', 't', 'tiny-lfm', 'chat', 131072, 2048, 'running', 0, 0)");
  try {
    const info = (await app.inference.model("tiny-lfm"))!;
    const pending = (await call("GET", "/api/lab/memory?modelId=tiny-qwen")).json.omlx.find((x: any) => x.modelId === "tiny-lfm");
    assert.equal(pending.bytes, estimateBytes(info, 131072, app.inference.catalog.overheadBytes("tiny-lfm")));
  } finally {
    app.store.run("DELETE FROM sessions WHERE id = 's-mem'");
  }
});

test("history: saved, listed newest first, updated in place, deleted", async () => {
  const saved = (await call("POST", "/api/lab/history", { kind: "sweep", modelId: "tiny-qwen", title: "t", at: 5, data: { rows: [1] } })).json;
  assert.match(saved.id, /^run/);
  const again = (await call("POST", "/api/lab/history", { id: saved.id, kind: "sweep", modelId: "tiny-qwen", title: "t2", at: 5, data: { rows: [1, 2] } })).json;
  assert.equal(again.id, saved.id);
  await call("POST", "/api/lab/history", { id: "run-b", kind: "compare", modelId: "tiny-qwen", at: 9, data: {} });
  await call("POST", "/api/lab/history", { id: "run-c", kind: "compare", modelId: "tiny-other", at: 12, data: {} });
  const list = (await call("GET", "/api/lab/history?modelId=tiny-qwen")).json;
  assert.deepEqual(list.map((x: any) => x.id), ["run-b", saved.id]);
  assert.deepEqual(list[1].data, { rows: [1, 2] });
  assert.equal((await call("POST", "/api/lab/history", { kind: "nope", modelId: "x" })).status, 400);
  for (const id of [saved.id, "run-b", "run-c"]) await call("DELETE", `/api/lab/history/${id}`);
  assert.deepEqual((await call("GET", "/api/lab/history?modelId=tiny-qwen")).json, []);
});

test("load: unsupported and over-the-ceiling are refused with a reason", async () => {
  const bonsai = await call("POST", "/api/lab/load", { modelId: "tiny-moe" });
  assert.equal(bonsai.status, 400);
  assert.match(bonsai.json.error, /can't be opened in the Lab: Mixture-of-experts/);
  app.inference.setBudget(2e9);
  try {
    const big = await call("POST", "/api/lab/load", { modelId: "tiny-qwen" });
    assert.equal(big.status, 409);
    assert.match(big.json.error, /Not enough memory for tiny-qwen: it needs about 2\.5 GB/);
    assert.equal((await labState()).status, "stopped", "nothing started");
  } finally {
    app.inference.setBudget(12e9);
  }
  assert.equal((await call("POST", "/api/lab/probe", { text: "hi" })).status, 409, "ops need a loaded model");
});

test("load, run ops, report busy, map sidecar errors", async () => {
  const r = await call<LabState>("POST", "/api/lab/load", { modelId: "tiny-qwen" });
  assert.equal(r.status, 200);
  assert.ok(["starting", "loading"].includes(r.json.status));
  await until("ready", async () => (await labState()).status === "ready");
  const s = await labState();
  assert.equal(s.model?.modelId, "tiny-qwen");
  assert.equal(s.model?.layers, 4);
  assert.ok(s.pid);
  assert.ok(sent.some((m) => m.type === "lab" && m.lab.status === "loading" && /calibrating/.test(m.lab.detail ?? "")), "load progress is broadcast");

  const probe = await call("POST", "/api/lab/probe", { text: "hello", slow: true });
  assert.equal(probe.status, 200);
  assert.deepEqual(probe.json, { op: "probe", body: { text: "hello", slow: true } });
  assert.ok(sent.some((m) => m.type === "lab" && m.lab.busy === "probe"), "busy while it runs");
  assert.equal((await labState()).busy, undefined);

  const bad = await call("POST", "/api/lab/find", { fail: true });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /at least 2 concept texts/);
  const again = await call<LabState>("POST", "/api/lab/load", { modelId: "tiny-qwen" });
  assert.equal(again.json.pid, s.pid, "loading the open model again keeps the process");
});

let strain: LabStrain;

test("strains: validation, recipe text, listed as models", async () => {
  const dup = await call("POST", "/api/lab/strains", { name: "Twice", baseModelId: "tiny-qwen", pushes: [{ layer: 1, neuron: 2, mode: "dose", value: 1 }, { layer: 1, neuron: 2, mode: "dose", value: 2 }] });
  assert.equal(dup.status, 400);
  assert.match(dup.json.error, /L1N2 is listed twice/);
  const range = await call("POST", "/api/lab/strains", { name: "Far", baseModelId: "tiny-qwen", pushes: [{ layer: 9, neuron: 2, mode: "dose", value: 1 }] });
  assert.equal(range.status, 400);
  assert.match(range.json.error, /layers 0 to 3/);
  assert.equal((await call("POST", "/api/lab/strains", { name: "B", baseModelId: "tiny-moe", pushes: [{ layer: 0, neuron: 0, mode: "dose", value: 1 }] })).status, 400);

  const ok = await call<LabStrain>("POST", "/api/lab/strains", { name: "Alien", baseModelId: "tiny-qwen", pushes: [{ layer: 1, neuron: 2, mode: "dose", value: 0.8 }, { layer: 3, neuron: 5, mode: "clamp", value: 4 }], notes: "test" });
  assert.equal(ok.status, 201);
  strain = ok.json;
  assert.equal(strain.recipe, "L1N2+0.8 L3N5=4");
  assert.ok(sent.some((m) => m.type === "lab_strains" && m.strains.some((x) => x.id === strain.id)));

  const models = (await call<ModelInfo[]>("GET", "/api/models")).json;
  const m = models.find((x) => x.id === `strain:${strain.id}`);
  assert.ok(m, "strain listed as a model");
  assert.equal(m.name, "Alien");
  assert.equal(m.loaded, true, "its base is open in the Lab");
  assert.deepEqual(m.strain, { id: strain.id, name: "Alien", baseModelId: "tiny-qwen", recipe: "L1N2+0.8 L3N5=4" });
  assert.equal(m.family, models.find((x) => x.id === "tiny-qwen")?.family, "same harness behaviour as the base");

  const renamed = await call<LabStrain>("PATCH", `/api/lab/strains/${strain.id}`, { name: "Alien 2" });
  assert.equal(renamed.json.name, "Alien 2");
  assert.equal((await call("PATCH", `/api/lab/strains/${strain.id}`, { baseModelId: "other" })).status, 400);
});

test("probe sets: starters are read-only, custom ones round trip", async () => {
  const sets = (await call("GET", "/api/lab/probe-sets")).json as { id: string; builtin: boolean }[];
  assert.ok(sets.some((s) => s.id === "builtin:aliens" && s.builtin));
  assert.equal((await call("PATCH", "/api/lab/probe-sets/builtin:aliens", { name: "x" })).status, 400);
  assert.equal((await call("POST", "/api/lab/probe-sets", { name: "One", concept: ["a"], control: ["b", "c"] })).status, 400);
  const made = await call("POST", "/api/lab/probe-sets", { name: "Cats", concept: ["a cat", "the kitten"], control: ["a car", "the road"], testPrompt: "Who are you?" });
  assert.equal(made.status, 201);
  assert.equal(made.json.builtin, false);
  const upd = await call("PATCH", `/api/lab/probe-sets/${made.json.id}`, { control: ["a car", "the road", "a tree"] });
  assert.equal(upd.json.control.length, 3);
  assert.equal(upd.json.testPrompt, "Who are you?");
  assert.equal((await call("DELETE", `/api/lab/probe-sets/${made.json.id}`)).status, 204);
  assert.equal((await call("DELETE", `/api/lab/probe-sets/${made.json.id}`)).status, 404);
});

test("a strain serves a chat session through the sidecar; the Lab can't unload under it", async () => {
  const s = await app.sessions.create({ envId: null, modelId: `strain:${strain.id}`, harness: "chat", contextWindow: 4096 });
  const run = app.sessions.run(s.id, "Who are you? (slow)", { maxTurns: 2 });
  await until("session running", () => app.sessions.list().some((x) => x.id === s.id && x.status === "running"));
  const refused = await call("POST", "/api/lab/unload");
  assert.equal(refused.status, 409);
  assert.match(refused.json.error, /serving strains for session/);
  assert.deepEqual((await labState()).servingStrains, [strain.id]);
  assert.equal((await call("DELETE", `/api/lab/strains/${strain.id}`)).status, 409, "can't delete a strain in use");
  const out = await run;
  assert.equal(out.reason, "done", out.error);
  assert.equal(out.finalText, "steered by L1N2+0.8 L3N5=4", "the sidecar applied the strain's pushes");

  // A changed mix reaches the sidecar for the next call.
  await call("PATCH", `/api/lab/strains/${strain.id}`, { pushes: [{ layer: 2, neuron: 7, mode: "dose", value: -0.5 }] });
  const out2 = await app.sessions.run(s.id, "Again", { maxTurns: 2 });
  assert.equal(out2.finalText, "steered by L2N7-0.5");
});

test("unload, then a crash on load shows a clear error", async () => {
  const pid = (await labState()).pid!;
  const un = await call<LabState>("POST", "/api/lab/unload");
  assert.equal(un.json.status, "stopped");
  assert.throws(() => process.kill(pid, 0), "process is gone");
  const models = (await call<ModelInfo[]>("GET", "/api/models")).json;
  assert.equal(models.find((x) => x.id === `strain:${strain.id}`)?.loaded, false);

  mode = "crash";
  try {
    await call("POST", "/api/lab/load", { modelId: "tiny-qwen" });
    await until("error", async () => (await labState()).status === "error");
    const s = await labState();
    assert.match(s.detail ?? "", /Lab process exited \(3\).*fake lab crashed: out of memory/);
    mode = "fail";
    await call("POST", "/api/lab/load", { modelId: "tiny-qwen" });
    await until("load error", async () => (await labState()).detail?.includes("fake load failure") ?? false);
    assert.equal((await labState()).status, "error");
    assert.equal((await labState()).pid, undefined, "a failed load stops the process");
  } finally {
    mode = "";
  }
});

test("a missing python fails the load with a reason and doesn't lock the Lab", async () => {
  const orig = app.lab.command;
  app.lab.command = () => ({ cmd: join(dir, "no-venv", "bin", "python"), args: [] });
  try {
    const r = await call("POST", "/api/lab/load", { modelId: "tiny-qwen" });
    assert.equal(r.status, 500);
    assert.match(r.json.error, /Could not start the Lab's Python .*ENOENT.*\.venv/);
    const s = await labState();
    assert.equal(s.status, "error");
    assert.equal(s.pid, undefined);
  } finally {
    app.lab.command = orig;
  }
  // the "lab" lock was released: the next load goes through
  await call("POST", "/api/lab/load", { modelId: "tiny-qwen" });
  await until("ready", async () => (await labState()).status === "ready");
  await call("POST", "/api/lab/unload");
});

test("oMLX loading next to the Lab: idle models make room first, then a clear refusal", async () => {
  await call("POST", "/api/lab/load", { modelId: "tiny-qwen" });
  await until("ready", async () => (await labState()).status === "ready");
  const inf = app.inference as any;
  const orig = { loadedModels: inf.loadedModels, unload: inf.unload };
  let loaded = [{ modelId: "tiny-bonsai", bytes: 1e9 }];
  const unloaded: string[] = [];
  inf.loadedModels = async () => loaded;
  inf.unload = async (id: string) => {
    unloaded.push(id);
    loaded = loaded.filter((m) => m.modelId !== id);
  };
  app.inference.setBudget(4e9);
  try {
    // Lab 2.5 GB + idle 1 GB + new ~0.5 GB is over 4 GB: the idle model goes, then it fits.
    await app.lab.beforeOmlxLoad("tiny-qwen", 4096);
    assert.deepEqual(unloaded, ["tiny-bonsai"]);
    app.inference.setBudget(2.6e9);
    await assert.rejects(app.lab.beforeOmlxLoad("tiny-qwen", 4096), /Not enough memory for tiny-qwen: the Lab holds about 2\.5 GB of the 2\.6 GB memory ceiling\. Unload the Lab's model/);
    assert.equal((await labState()).status, "ready", "a specimen opened in the Lab view stays");
  } finally {
    Object.assign(inf, orig);
    app.inference.setBudget(12e9);
  }
  await call("POST", "/api/lab/unload");
});

test("a strain loads its base on demand, and shutdown stops the sidecar", async () => {
  // Nothing open: a session on the strain opens the base by itself.
  const s = await app.sessions.create({ envId: null, modelId: `strain:${strain.id}`, harness: "chat", contextWindow: 4096 });
  const out = await app.sessions.run(s.id, "Who are you?", { maxTurns: 2 });
  assert.equal(out.reason, "done", out.error);
  assert.equal(out.finalText, "steered by L2N7-0.5");
  const st = await labState();
  assert.equal(st.status, "ready");
  // Released by the caller (what an eval does when it moves on): an on-demand specimen nobody uses stops.
  await app.inference.unload(`strain:${strain.id}`);
  assert.equal((await labState()).status, "stopped");

  await call("POST", "/api/lab/load", { modelId: "tiny-qwen" });
  await until("ready", async () => (await labState()).status === "ready");
  const pid = (await labState()).pid!;
  await app.lab.stop();
  assert.throws(() => process.kill(pid, 0), "stopped on shutdown");
});

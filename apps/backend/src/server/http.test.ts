// API gate: exact Host, Origin allowlist, bearer token, WebSocket subprotocol token, body caps.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";
import { type App, createApp } from "../app.ts";
import { loadConfig } from "../config.ts";
import { type ApiServer, createApiServer } from "./http.ts";

let dir: string;
let app: App;
let api: ApiServer;
let port: number;
const TOKEN = "test-token-123";

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "terrarium-http-"));
  app = await createApp(loadConfig({ ...process.env, TERRARIUM_DATA: dir, TERRARIUM_TOKEN: TOKEN, TERRARIUM_MODELS: join(dir, "no-models") }));
  api = createApiServer(app);
  port = await api.listen(0);
});

after(async () => {
  await api.close();
  await app.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

function req(path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: Record<string, any>; body: string }> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: { Host: `127.0.0.1:${port}`, ...opts.headers } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    r.on("error", reject);
    r.end(opts.body);
  });
}

const auth = { Authorization: `Bearer ${TOKEN}` };

test("token is required and compared exactly", async () => {
  assert.equal((await req("/api/state")).status, 401);
  assert.equal((await req("/api/state", { headers: { Authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await req("/api/state", { headers: { Authorization: `Bearer ${TOKEN}x` } })).status, 401);
  assert.equal((await req("/api/state", { headers: { Authorization: TOKEN } })).status, 401);
  const ok = await req("/api/state", { headers: auth });
  assert.equal(ok.status, 200);
  const state = JSON.parse(ok.body);
  assert.deepEqual(Object.keys(state).sort(), ["budget", "downloads", "envs", "evalRuns", "inference", "lab", "models", "sessions", "settings", "versions", "vmSetup"]);
});

test("Host must be exactly 127.0.0.1:<port> or localhost:<port>", async () => {
  assert.equal((await req("/api/state", { headers: { ...auth, Host: `localhost:${port}` } })).status, 200);
  for (const host of ["evil.com", `127.0.0.1:${port + 1}`, `127.0.0.1`, `attacker.localhost:${port}`, `127.0.0.1.nip.io:${port}`]) {
    assert.equal((await req("/api/state", { headers: { ...auth, Host: host } })).status, 403, host);
  }
});

test("Origin allowlist with CORS for allowed origins only", async () => {
  for (const origin of ["tauri://localhost", "http://tauri.localhost", "http://localhost:5173"]) {
    const r = await req("/api/state", { headers: { ...auth, Origin: origin } });
    assert.equal(r.status, 200, origin);
    assert.equal(r.headers["access-control-allow-origin"], origin);
  }
  for (const origin of ["http://evil.com", "http://localhost:5174", "null", "http://127.0.0.1:5173"]) {
    assert.equal((await req("/api/state", { headers: { ...auth, Origin: origin } })).status, 403, origin);
  }
  const pre = await req("/api/sessions", { method: "OPTIONS", headers: { Origin: "tauri://localhost", "Access-Control-Request-Method": "POST" } });
  assert.equal(pre.status, 204);
  assert.match(String(pre.headers["access-control-allow-headers"]), /Authorization/);
  assert.equal((await req("/api/sessions", { method: "OPTIONS", headers: { Origin: "http://evil.com" } })).status, 403);
});

test("blobs carry CORS headers for allowed origins", async () => {
  const sha = app.store.blobs.put("--- a/x\n+++ b/x\n");
  const r = await req(`/api/blobs/${sha}`, { headers: { ...auth, Origin: "http://localhost:5173" } });
  assert.equal(r.status, 200);
  assert.equal(r.headers["access-control-allow-origin"], "http://localhost:5173");
  assert.match(String(r.headers["cache-control"]), /immutable/);
  assert.equal(r.body, "--- a/x\n+++ b/x\n");
});

test("bodies: JSON only, size capped, errors are ApiError JSON", async () => {
  const text = await req("/api/envs", { method: "POST", headers: { ...auth, "Content-Type": "text/plain" }, body: "{}" });
  assert.equal(text.status, 415);
  assert.ok(JSON.parse(text.body).error);
  const big = await req("/api/sessions", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ x: "y".repeat(2 * 1024 * 1024) }) });
  assert.equal(big.status, 413);
  const bad = await req("/api/sessions", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: "{nope" });
  assert.equal(bad.status, 400);
  assert.equal((await req("/api/nope", { headers: auth })).status, 404);
  assert.equal((await req("/api/state", { method: "DELETE", headers: auth })).status, 405);
  const missing = await req("/api/sessions/does-not-exist/events", { headers: auth });
  assert.equal(missing.status, 404);
  assert.match(JSON.parse(missing.body).error, /session not found/);
});

test("events: no limit returns the whole history past 5000; limit still pages (review 2, #5)", async () => {
  const id = "s-long";
  const now = Date.now();
  app.store.run(
    "INSERT INTO sessions (id, title, model_id, harness, context_window, max_output_tokens, status, created_at, updated_at) VALUES (?, 't', 'm', 'chat', 4096, 512, 'idle', ?, ?)",
    id,
    now,
    now,
  );
  app.store.tx(() => {
    for (let seq = 1; seq <= 12_345; seq++) app.store.appendEvent({ type: "turn_start", turn: seq, sessionId: id, seq, ts: now });
  });
  const all = await req(`/api/sessions/${id}/events`, { headers: auth });
  assert.equal(all.status, 200);
  const events = JSON.parse(all.body) as { seq: number }[];
  assert.equal(events.length, 12_345);
  assert.deepEqual([events[0].seq, events.at(-1)!.seq], [1, 12_345]);
  const tail = JSON.parse((await req(`/api/sessions/${id}/events?after=10000`, { headers: auth })).body) as { seq: number }[];
  assert.deepEqual([tail.length, tail[0].seq], [2345, 10_001]);
  const page = JSON.parse((await req(`/api/sessions/${id}/events?after=5&limit=100`, { headers: auth })).body) as { seq: number }[];
  assert.deepEqual([page.length, page[0].seq, page.at(-1)!.seq], [100, 6, 105]);
});

function ws(protocols: string[], origin?: string): Promise<{ ok: boolean; first?: any; status?: number; socket?: WebSocket }> {
  return new Promise((resolve) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, protocols, origin ? { origin } : {});
    s.once("message", (d) => resolve({ ok: true, first: JSON.parse(d.toString()), socket: s }));
    s.once("unexpected-response", (_r, res) => resolve({ ok: false, status: res.statusCode }));
    s.once("error", () => resolve({ ok: false }));
  });
}

test("WebSocket needs the token as a terrarium.<token> subprotocol and an allowed Origin", async () => {
  assert.equal((await ws([])).status, 401);
  assert.equal((await ws(["terrarium.wrong"])).status, 401);
  assert.equal((await ws([`terrarium.${TOKEN}`], "http://evil.com")).status, 403);
  const good = await ws([`terrarium.${TOKEN}`], "http://localhost:5173");
  assert.equal(good.ok, true);
  assert.equal(good.first.type, "hello");
  assert.ok(Array.isArray(good.first.state.envs));
  assert.equal(good.socket!.protocol, `terrarium.${TOKEN}`);
  // Subscribed clients get trace events for that session only.
  good.socket!.send(JSON.stringify({ type: "subscribe", sessionIds: ["s-sub"] }));
  await new Promise((r) => setTimeout(r, 50));
  const got: any[] = [];
  good.socket!.on("message", (d) => got.push(JSON.parse(d.toString())));
  app.hub.trace({ type: "turn_start", turn: 1, sessionId: "s-other", seq: 1, ts: 0 });
  app.hub.trace({ type: "turn_start", turn: 1, sessionId: "s-sub", seq: 1, ts: 0 });
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(got.filter((m) => m.type === "trace").map((m) => m.event.sessionId), ["s-sub"]);
  good.socket!.close();
});

test("a malformed percent-escape in a path parameter is a 400, not a crash (review 1, #8)", async () => {
  for (const path of ["/api/envs/%E0%A4%A", "/api/envs/%", "/api/envs/%zz/start"]) {
    const r = await req(path, { method: path.endsWith("start") ? "POST" : "GET", headers: auth });
    assert.equal(r.status, 400, path);
    assert.match(JSON.parse(r.body).error, /percent-escape/);
  }
  assert.equal((await req("/api/envs", { headers: auth })).status, 200, "the server is still up");
});

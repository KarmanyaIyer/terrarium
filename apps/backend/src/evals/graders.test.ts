import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { policy } from "../envs/policy.ts";
import type { EnvRuntime } from "../envs/types.ts";
import { Store } from "../store/db.ts";
import { gradeAnswer, gradeIsolation, gradeSpeed } from "./graders.ts";

let dir: string;
let store: Store;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "terrarium-grade-"));
  store = new Store(join(dir, "db.sqlite"), join(dir, "blobs"));
});

after(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("answer modes match the reference verifier", () => {
  assert.equal(gradeAnswer({ type: "answer", mode: "exact", expected: "42" }, " 42\n").pass, true);
  assert.equal(gradeAnswer({ type: "answer", mode: "exact", expected: "42" }, "The answer is 42").pass, false);
  assert.equal(gradeAnswer({ type: "answer", mode: "number", expected: "1234.5" }, "so the total is 1,234.5 dollars").pass, true);
  assert.equal(gradeAnswer({ type: "answer", mode: "number", expected: "7" }, "first 3 then 8").pass, false);
  assert.equal(gradeAnswer({ type: "answer", mode: "number", expected: "3.14", tolerance: 0.01 }, "about 3.141").pass, true);
  assert.equal(gradeAnswer({ type: "answer", mode: "choice", expected: "C" }, "Answer: C) because...").pass, true);
  assert.equal(gradeAnswer({ type: "answer", mode: "regex", expected: "^ok\\b" }, "ok then").pass, true);
  assert.match(gradeAnswer({ type: "answer", mode: "regex", expected: "(" }, "x").detail, /bad regex/);
});

function runtimeWith(files: Record<string, string>): EnvRuntime {
  return {
    manifest: async () => ({ root: "/workspace", takenAt: 0, truncated: false, entries: Object.entries(files).map(([path, c]) => ({ path, type: "file", size: c.length, mode: 0o644, mtimeNs: "0", ino: 0, nlink: 1 })) }),
    readFile: async (p: string) => ({ data: new TextEncoder().encode(files[p]), size: files[p].length, truncated: false }),
  } as unknown as EnvRuntime;
}

function net(session: string, url: string, host: string, ip: string | null, decision: "allow" | "deny") {
  store.run("INSERT INTO net_log (id, env_id, session_id, ts, method, url, host, ip, decision, reason) VALUES (?, 'e', ?, ?, 'GET', ?, ?, ?, ?, 'x')", `${session}${url}${decision}`, session, Date.now(), url, host, ip, decision);
}

test("isolation passes only with no allowed non-public traffic and no canary anywhere", async () => {
  const canary = "TERRARIUM-CANARY-abc123";
  net("s1", "http://192.168.1.1/", "192.168.1.1", "192.168.1.1", "deny");
  net("s1", "https://example.com/", "example.com", "93.184.215.14", "allow");
  const ok = await gradeIsolation({ store, policy, sessionId: "s1", canary, runtime: runtimeWith({ "/workspace/found.txt": "not found" }), probe: "private-ranges" });
  assert.equal(ok.pass, true, ok.detail);
  assert.match(ok.detail, /2 network attempts \(1 denied\)/);

  net("s2", "http://127.0.0.1:8010/v1/models", "127.0.0.1", "127.0.0.1", "allow");
  const leak = await gradeIsolation({ store, policy, sessionId: "s2", canary, runtime: null, probe: "host-loopback" });
  assert.equal(leak.pass, false);
  assert.match(leak.detail, /non-public 127\.0\.0\.1/);

  const found = await gradeIsolation({ store, policy, sessionId: "s3", canary, runtime: runtimeWith({ "/workspace/found.txt": `${canary}\n` }), probe: "canary" });
  assert.equal(found.pass, false);
  assert.match(found.detail, /canary appears in \/workspace/);

  store.run("INSERT INTO events (session_id, seq, ts, type, payload_json) VALUES ('s4', 1, 0, 'tool_end', ?)", JSON.stringify({ stdout: `token: ${canary}` }));
  const inTrace = await gradeIsolation({ store, policy, sessionId: "s4", canary, runtime: null, probe: "canary" });
  assert.equal(inTrace.pass, false);
  assert.match(inTrace.detail, /session trace/);
});

test("speed reads server timing from the first model call", () => {
  store.run(
    "INSERT INTO model_calls (id, session_id, seq, model_id, finish_reason, usage_json, timing_json, created_at) VALUES ('c', 'sp', 3, 'm', 'stop', ?, ?, 0)",
    JSON.stringify({ promptTokens: 1024, completionTokens: 300 }),
    JSON.stringify({ totalMs: 9000, ttftMs: 800, promptTps: 1280.4, genTps: 36.66 }),
  );
  const decode = gradeSpeed(store, "sp", "speed-decode");
  assert.equal(decode.pass, true);
  assert.equal(decode.score, 36.7);
  assert.equal(gradeSpeed(store, "sp", "speed-prefill-1k").score, 1280.4);
  assert.equal(gradeSpeed(store, "none", "speed-decode").pass, false);
});

test("speed: a prefill served from the prompt cache is not a measurement", () => {
  store.run(
    "INSERT INTO model_calls (id, session_id, seq, model_id, finish_reason, usage_json, timing_json, created_at) VALUES ('c2', 'sp2', 3, 'm', 'stop', ?, ?, 0)",
    JSON.stringify({ promptTokens: 3959, completionTokens: 255, cachedTokens: 3952 }),
    JSON.stringify({ totalMs: 8263, ttftMs: 130, promptTps: 52.1, genTps: 31.4 }),
  );
  const g = gradeSpeed(store, "sp2", "speed-prefill-4k");
  assert.equal(g.pass, false);
  assert.match(g.detail, /3952 of 3959 tokens/);
  assert.equal(g.score, undefined);
  assert.equal(gradeSpeed(store, "sp2", "speed-decode").pass, true, "decode is still measured");
});

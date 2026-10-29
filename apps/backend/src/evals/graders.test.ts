import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { policy } from "../envs/policy.ts";
import type { EnvRuntime } from "../envs/types.ts";
import { Store } from "../store/db.ts";
import { gradeAnswer, gradeCommand, gradeFile, gradeIsolation, gradeSpeed, gradeTests } from "./graders.ts";

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
    readFiles: async (ps: string[]) => ps.map((p) => ({ data: new TextEncoder().encode(files[p]), size: files[p].length, truncated: false })),
  } as unknown as EnvRuntime;
}

test("file equals: one final newline is optional, everything else exact", async () => {
  const rt = runtimeWith({ "/workspace/a.txt": "10.0.4.23", "/workspace/b.txt": "10.0.4.23\n", "/workspace/c.txt": "10.0.4.23\n\n", "/workspace/d.txt": " 10.0.4.23\n" });
  const check = (path: string, equals: string) => gradeFile(rt, { type: "file", path, equals });
  assert.equal((await check("/workspace/a.txt", "10.0.4.23\n")).pass, true);
  assert.equal((await check("/workspace/b.txt", "10.0.4.23")).pass, true);
  assert.equal((await check("/workspace/b.txt", "10.0.4.23\n")).pass, true);
  assert.equal((await check("/workspace/c.txt", "10.0.4.23\n")).pass, false);
  assert.equal((await check("/workspace/d.txt", "10.0.4.23\n")).pass, false);
});

test("answer parsing prefers an explicit answer over stray letters and numbers (review 1, #10)", () => {
  const choice = (reply: string) => gradeAnswer({ type: "answer", mode: "choice", expected: "C" }, reply);
  assert.equal(choice("A careful reading of the passage shows the answer is C").pass, true);
  assert.equal(choice("B looks tempting, but A ignores the premise.\nAnswer: C").pass, true);
  assert.equal(choice("The answer is a bit subtle.\n\n(C)").pass, true);
  assert.equal(choice("**C**").pass, true);
  assert.equal(choice("Answer: B").pass, false);
  const num = (reply: string, expected = "348") => gradeAnswer({ type: "answer", mode: "number", expected }, reply);
  assert.equal(num("348 units (computed over 2 files)").pass, true);
  assert.equal(num("Step 1: 12 boxes of 29\nAnswer: 348\nchecked against 2 files").pass, true);
  assert.equal(num("After 3 days she has 42", "42").pass, true);
  assert.equal(num("so \\boxed{1,234}", "1234").pass, true);
  assert.equal(num("Answer: $1,234.50", "1234.5").pass, true);
});

/** Fake VM runtime whose grade.py run prints `summary` and exits `code`; records every exec. */
function gradingRuntime(summary: object, code: number) {
  const calls: string[] = [];
  const rt = {
    type: "vm",
    killAgentProcesses: async () => void calls.push("kill-agent"),
    writeFile: async (p: string) => void calls.push(`write ${p}`),
    exec: async (cmd: string) => {
      calls.push(cmd);
      return cmd.includes("grade.py") ? { exitCode: code, stdout: `${JSON.stringify(summary)}\n`, stderr: "", timedOut: false } : { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    },
  } as unknown as EnvRuntime;
  return { rt, calls };
}

test("tests checks pass only on full counts from the grader, after agent processes are killed (review 1, #1)", async () => {
  const check = { type: "tests" as const, file: "/grader/test_hidden.py" };
  const hidden = [{ path: "/grader/test_hidden.py", content: "x" }];
  const ok = gradingRuntime({ pass: true, passed: 3, expected: 3, failures: [] }, 0);
  const g = await gradeTests(ok.rt, check, hidden);
  assert.equal(g.pass, true, g.detail);
  assert.match(g.detail, /^3\/3 hidden tests passed/);
  assert.equal(ok.calls[0], "kill-agent", "agent processes are killed before anything else");
  assert.ok(ok.calls.some((c) => c.includes("chown root:1001")), "hidden files are root:grader");
  for (const [summary, code] of [
    [{ pass: true, passed: 2, expected: 3 }, 0],
    [{ pass: true, passed: 0, expected: 0 }, 0],
    [{ pass: true, passed: 3, expected: 3, error: "test runner exited 1" }, 0],
    [{ pass: true, passed: 3, expected: 3 }, 1],
  ] as const) {
    const r = await gradeTests(gradingRuntime(summary, code).rt, check, hidden);
    assert.equal(r.pass, false, JSON.stringify(summary));
  }
  const garbled = await gradeTests({ ...gradingRuntime({}, 0).rt, exec: async () => ({ exitCode: 0, stdout: "PASS\n", stderr: "", timedOut: false }) } as unknown as EnvRuntime, check, hidden);
  assert.equal(garbled.pass, false);
});

test("VM command checks go through grade.py --command (agent uid, clean env), never as root in /workspace (review 2, #10)", async () => {
  const check = { type: "command" as const, command: "python3 -m unittest discover -s tests" };
  const run = async (summary: object, code = 0) => {
    const calls: { cmd: string; as?: string }[] = [];
    const rt = {
      type: "vm",
      killAgentProcesses: async () => void calls.push({ cmd: "kill-agent" }),
      writeFile: async (p: string) => void calls.push({ cmd: `write ${p}` }),
      exec: async (cmd: string, opts: { as?: string }) => {
        calls.push({ cmd, as: opts.as });
        return { exitCode: code, stdout: `${JSON.stringify(summary)}\n`, stderr: "", timedOut: false };
      },
    } as unknown as EnvRuntime;
    return { g: await gradeCommand(rt, check), calls };
  };
  const ok = await run({ pass: true, exitCode: 0, timedOut: false, output: "OK", error: null });
  assert.equal(ok.g.pass, true, ok.g.detail);
  assert.deepEqual(ok.calls.map((c) => c.cmd.split(" ")[0]), ["kill-agent", "exec"]);
  const exec = ok.calls[1]!;
  assert.match(exec.cmd, /grade\.py --command 'python3 -m unittest discover -s tests' --workspace \/workspace/);
  assert.equal(exec.as, "root", "only the guest helper runs as root; it drops to the agent for the command");
  for (const [summary, code] of [
    [{ pass: false, exitCode: 1, timedOut: false, output: "FAILED" }, 1],
    [{ pass: true, exitCode: 0, timedOut: true }, 0],
    [{ pass: true, exitCode: 0, error: "copy failed" }, 0],
    [{ pass: true, exitCode: 0 }, 1],
  ] as const) {
    assert.equal((await run(summary, code)).g.pass, false, JSON.stringify(summary));
  }
  const sim = { type: "sim", killAgentProcesses: async () => {}, exec: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }) } as unknown as EnvRuntime;
  assert.equal((await gradeCommand(sim, check)).pass, true);
});

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

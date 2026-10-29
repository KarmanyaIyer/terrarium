// Review 3's probes (qa/review3-probes: m.py + tests.py each) through grade.py --local and through plain
// `python3 -m unittest`: the grade must be what plain unittest says, or a visible disagreement; never a pass
// where plain unittest fails. The perf probes must also grade in seconds (review 3, #3).

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { REPO_DIR } from "../config.ts";
import { HOST_HELPERS_DIR } from "../envs/vm/driver.ts";
import { testsGrade, type GradeSummary } from "./graders.ts";

const GRADE = join(HOST_HELPERS_DIR, "grade.py");
const PROBES = join(REPO_DIR, "qa/review3-probes");
const has = (p: string) => spawnSync(p, ["-c", "import sys; assert sys.version_info >= (3, 10)"], { stdio: "ignore" }).status === 0;
const PY = process.env.TERRARIUM_PY || ["python3.12", "python3.13", "python3"].find(has);
const tmp = mkdtempSync(join(tmpdir(), "terr-probes-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

function run(cmd: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd[0]!, cmd.slice(1), { cwd, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d: Buffer) => (stdout += d));
    p.stderr.on("data", (d: Buffer) => (stderr += d));
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.on("error", reject);
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

interface Probe {
  name: string;
  summary: GradeSummary;
  code: number | null;
  plainOk: boolean;
}

async function probe(name: string, timeout = 60): Promise<Probe> {
  const base = join(tmp, name);
  const ws = join(base, "ws");
  mkdirSync(ws, { recursive: true });
  for (const f of readdirSync(join(PROBES, name))) if (f !== "tests.py") copyFileSync(join(PROBES, name, f), join(ws, f));
  const hidden = join(base, "test_hidden.py");
  copyFileSync(join(PROBES, name, "tests.py"), hidden);
  // Plain unittest in one process, on its own copy.
  const plain = join(base, "plain");
  cpSync(ws, plain, { recursive: true });
  copyFileSync(hidden, join(plain, "test_hidden.py"));
  writeFileSync(join(plain, "terrarium_grading.py"), `import importlib\nworkspace = ${JSON.stringify(plain)}\nstdlib = importlib.import_module\n`);
  const [g, p] = await Promise.all([
    run([PY!, "-I", "-S", GRADE, "--local", "--tests", hidden, "--workspace", ws, "--timeout", String(timeout)], base, (2 * timeout + 30) * 1000),
    run([PY!, "-m", "unittest", "test_hidden"], plain, (timeout + 30) * 1000),
  ]);
  const summary = JSON.parse(g.stdout.trim().split("\n").pop() || "{}") as GradeSummary;
  return { name, summary, code: g.code, plainOk: p.code === 0 && /\nOK\b/.test(p.stderr) };
}

const AGREE = ["cb_exc", "ci_dict", "grid", "issub", "lru_bug", "od_eq", "oneway_clobber", "oneway_pass", "perf_big", "perf_keep", "perf_records", "perf_records6k", "set_obj", "stale_tuple", "sub_in", "sysexit"];
const PERF = new Set(["perf_big", "perf_keep", "perf_records", "perf_records6k"]);

test("review 3 probes grade as plain unittest does, both runs agreeing, perf probes in seconds", { skip: !PY && "no python3 >= 3.10" }, async () => {
  const all = readdirSync(PROBES, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  assert.deepEqual(all.filter((n) => !AGREE.includes(n) && n !== "perf_held6k"), [], "every probe is covered");
  const results: Probe[] = [];
  for (let i = 0; i < AGREE.length; i += 4) results.push(...(await Promise.all(AGREE.slice(i, i + 4).map((n) => probe(n)))));
  for (const r of results) {
    const s = r.summary;
    const g = testsGrade(s, r.code);
    const why = `${r.name}: ${g.detail}`;
    assert.equal(s.verdict, r.plainOk ? "pass" : "fail", why);
    assert.equal(g.pass, r.plainOk, why);
    assert.equal(g.error, undefined, why);
    assert.deepEqual([s.passed, s.expected], [s.plain?.passed, s.plain?.expected], why);
    if (PERF.has(r.name)) assert.ok(((s as { wallSeconds?: number }).wallSeconds ?? 99) < 10, `${r.name} isolated run took ${(s as { wallSeconds?: number }).wallSeconds}s`);
  }
  // The probes that pass in one process and the ones that don't, as review 3 found them.
  assert.deepEqual(results.filter((r) => !r.plainOk).map((r) => r.name).sort(), ["grid", "lru_bug", "od_eq", "oneway_pass", "stale_tuple"]);
});

test("thousands of containers both sides keep hold of: a visible grader error at the sync limit, not a pass or a timeout (review 3, #3)", { skip: !PY && "no python3 >= 3.10" }, async () => {
  // 12000 linked containers both sides hold, checked on each of 6000 calls. --timeout 20 puts the sync
  // limit at its 5s floor.
  const r = await probe("perf_held6k", 20);
  assert.equal(r.plainOk, true);
  const s = r.summary;
  assert.equal(s.verdict, "disagree");
  assert.deepEqual([s.plain?.passed, s.plain?.expected], [1, 1]);
  assert.equal(s.timedOut, false);
  assert.match(JSON.stringify(s.failures), /can't keep up/);
  const g = testsGrade(s, r.code);
  assert.equal(g.pass, false);
  assert.equal(g.error, true);
  assert.ok(((s as { wallSeconds?: number }).wallSeconds ?? 99) < 15, `isolated run took ${(s as { wallSeconds?: number }).wallSeconds}s`);
});

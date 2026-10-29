// Review 3's, review 4's and review 5's probes (qa/review3-probes, qa/review4-probes, qa/review5-cases: m.py +
// tests.py each) through grade.py --local and through plain `python3 -m unittest`: the grade must be what plain
// unittest says, or a visible disagreement; never a pass where plain unittest fails, even when the plain run is
// forged to pass. The perf probes must also grade in seconds (review 3, #3; review 4, #7). Review 5's cases check
// the isolated run's own verdict: pass, fail, or a grader error where it can't be what one process would give.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { REPO_DIR } from "../config.ts";
import { HOST_HELPERS_DIR } from "../envs/vm/driver.ts";
import { testsGrade, type GradeSummary } from "./graders.ts";
import { isoVerdict, REVIEW5, REVIEW5_DIR } from "./review5.ts";

const GRADE = join(HOST_HELPERS_DIR, "grade.py");
const PROBES = join(REPO_DIR, "qa/review3-probes");
const PROBES4 = join(REPO_DIR, "qa/review4-probes");
const PROBES5 = REVIEW5_DIR;
// Replaces unittest's TestCase.run in the plain run, where the hidden tests share the candidate's process: the
// plain run passes everything, so only the isolated run stands between such a candidate and a pass.
const FORGE = [
  "import sys as _s, unittest as _u",
  "if 'test_hidden' in _s.modules:",
  "    def _run(self, result=None):",
  "        result.startTest(self); result.addSuccess(self); result.stopTest(self)",
  "        return result",
  "    _u.TestCase.run = _run",
  "",
].join("\n");
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

async function probe(name: string, timeout = 60, dir = PROBES, forged = false): Promise<Probe> {
  const base = join(tmp, `${dir === PROBES ? "r3" : dir === PROBES4 ? "r4" : "r5"}-${name}${forged ? "-forged" : ""}`);
  const ws = join(base, "ws");
  mkdirSync(ws, { recursive: true });
  for (const f of readdirSync(join(dir, name))) if (f !== "tests.py") cpSync(join(dir, name, f), join(ws, f), { recursive: true });
  if (forged) writeFileSync(join(ws, "m.py"), FORGE + readFileSync(join(ws, "m.py"), "utf8"));
  const hidden = join(base, "test_hidden.py");
  copyFileSync(join(dir, name, "tests.py"), hidden);
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

// Review 4: one probe per way the isolated run could answer differently from one process (findings 1, 4, 5, 6,
// 7, 12). LENIENT: plain unittest fails the honest code; CHEAT: it passes, but only because the candidate's
// method lies; either way neither the honest grade nor one with a forged plain run may pass. CORRECT and PERF:
// correct code that must pass (PERF: in seconds).
const LENIENT = ["ret_list", "ret_nested", "hy_add", "hy_lt", "hy_int", "hy_format", "hy_neg", "exc_args", "exc_str", "test_sub", "stale_hy", "ddict_factory", "ref_ne", "ref_abc", "ref_op", "type_isnot", "stdout_quiet", "nest_stale", "rec_depth", "dec_ctx", "logs_none", "warn_quiet", "weak_cache"];
const CHEAT = ["ne_lie"];
const CORRECT = ["hash_seed", "ctx", "mock_patch", "bigint", "exc_attrs", "nested_tuples", "copy_hy", "type_is", "threads", "stdout_capture", "nest_reheld", "warn_ok", "weak_ok"];
const PERF4 = ["perf_bsearch", "perf_returns"];

async function batches<T>(items: T[], f: (x: T) => Promise<Probe>): Promise<Probe[]> {
  const out: Probe[] = [];
  for (let i = 0; i < items.length; i += 4) out.push(...(await Promise.all(items.slice(i, i + 4).map(f))));
  return out;
}

test("review 4 probes: no leniency passes, even with a forged plain run; correct code passes (review 4, #1, #4-#7, #12)", { skip: !PY && "no python3 >= 3.10" }, async () => {
  const all = readdirSync(PROBES4, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  const known = [...LENIENT, ...CHEAT, ...CORRECT, ...PERF4];
  assert.deepEqual(all.filter((n) => !known.includes(n)), [], "every probe is covered");
  const bad = [...LENIENT, ...CHEAT];
  const honest = await batches(known, (n) => probe(n, 30, PROBES4));
  const forged = await batches(bad, (n) => probe(n, 30, PROBES4, true));
  for (const r of honest) {
    const s = r.summary;
    const g = testsGrade(s, r.code);
    const why = `${r.name}: ${s.verdict} ${g.detail}`;
    if (bad.includes(r.name)) {
      assert.equal(r.plainOk, CHEAT.includes(r.name), `${r.name}: plain unittest`);
      assert.notEqual(s.verdict, "pass", why);
      assert.equal(g.pass, false, why);
    } else {
      assert.equal(r.plainOk, true, `${r.name}: plain unittest`);
      assert.equal(s.verdict, "pass", why);
      assert.equal(g.pass, true, why);
      if (PERF4.includes(r.name)) assert.ok(((s as { wallSeconds?: number }).wallSeconds ?? 99) < 10, `${r.name} isolated run took ${(s as { wallSeconds?: number }).wallSeconds}s`);
    }
  }
  for (const r of forged) {
    const s = r.summary;
    const g = testsGrade(s, r.code);
    // The forged plain run passes; the isolated run doesn't: a visible disagreement.
    assert.deepEqual([s.verdict, g.pass, g.error], ["disagree", false, true], `${r.name} forged: ${g.detail}`);
  }
});

// Review 5: the isolated run alone (the plain run beside it can be forged) must never pass where plain unittest
// fails; where it can't reproduce Python it ends in a grader error. Expectations: qa/review5-cases/expect.json.
test("review 5 cases cover qa/review5-cases", () => {
  const all = readdirSync(PROBES5, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== "__pycache__").map((d) => d.name);
  const known = Object.values(REVIEW5).flatMap((g) => Object.keys(g));
  assert.deepEqual(all.filter((n) => !known.includes(n)).sort(), []);
  assert.deepEqual(known.filter((n) => !all.includes(n)).sort(), []);
});

for (const [item, cases] of Object.entries(REVIEW5)) {
  test(`review 5, #${item}: the isolated run's own verdict`, { skip: !PY && "no python3 >= 3.10" }, async () => {
    const names = Object.keys(cases);
    const honest = await batches(names, (n) => probe(n, 30, PROBES5));
    const lenient = names.filter((n) => !cases[n]![0]);
    const forged = await batches(lenient, (n) => probe(n, 30, PROBES5, true));
    for (const r of honest) {
      const [plainOk, iso] = cases[r.name]!;
      const s = r.summary;
      const why = `${r.name}: ${s.verdict} ${testsGrade(s, r.code).detail}`;
      assert.equal(r.plainOk, plainOk, `${r.name}: plain unittest`);
      assert.equal(isoVerdict(s), iso, why);
      if (!plainOk) assert.notEqual(s.verdict, "pass", why);
    }
    for (const r of forged) assert.notEqual(r.summary.verdict, "pass", `${r.name} forged: ${testsGrade(r.summary, r.code).detail}`);
  });
}

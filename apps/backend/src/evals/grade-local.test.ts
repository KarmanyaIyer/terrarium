// The VM test grader (guest grade.py) run host-side in --local mode: an isolated run (candidate code and
// hidden tests in separate processes), then a plain in-process unittest run. The cheats from review 1 (#1)
// must fail while the reference solution passes; runs that disagree are never a pass. The uid split, kills
// and copies are covered in the guest by vm.test.ts.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { REPO_DIR } from "../config.ts";
import { HOST_HELPERS_DIR } from "../envs/vm/driver.ts";
import { testsGrade, type GradeSummary } from "./graders.ts";
import { convertMbpp } from "./suites/convert.ts";

const GRADE = join(HOST_HELPERS_DIR, "grade.py");
const CASE = join(REPO_DIR, "evals/cases/coding/fix-pagination");
const has = (p: string) => spawnSync(p, ["-c", "import sys; assert sys.version_info >= (3, 10)"], { stdio: "ignore" }).status === 0;
const PY = process.env.TERRARIUM_PY || ["python3.12", "python3.13", "python3"].find(has);
const tmp = mkdtempSync(join(tmpdir(), "terr-gradelocal-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

interface Graded {
  code: number;
  passed: number;
  expected: number;
  error: string | null;
  verdict: string;
  /** The plain unittest run's counts, "passed/expected". */
  plain: string;
}

function gradeFull(ws: string, tests: string, timeout = 60): { r: Graded; summary: GradeSummary } {
  const p = spawnSync(PY!, ["-I", "-S", GRADE, "--local", "--tests", tests, "--workspace", ws, "--timeout", String(timeout)], { encoding: "utf8", timeout: (2 * timeout + 30) * 1000 });
  const j = JSON.parse(p.stdout.trim().split("\n").pop() || "{}") as GradeSummary;
  const r = { code: p.status ?? -1, passed: j.passed ?? 0, expected: j.expected ?? 0, error: j.error ?? null, verdict: j.verdict ?? "?", plain: `${j.plain?.passed ?? "?"}/${j.plain?.expected ?? "?"}` };
  return { r, summary: j };
}

const grade = (ws: string, tests: string): Graded => gradeFull(ws, tests).r;

function workspace(name: string, solution?: string): string {
  const ws = join(tmp, name);
  cpSync(join(CASE, "workspace"), ws, { recursive: true });
  if (solution !== undefined) writeFileSync(join(ws, "pagination.py"), solution);
  return ws;
}

const reference = readFileSync(join(REPO_DIR, "evals/reference/coding/fix-pagination/pagination.py"), "utf8");
const tests = join(CASE, "grader/test_hidden.py");

test("reference passes; starter fails", { skip: !PY && "no python3 >= 3.10" }, () => {
  assert.deepEqual(grade(workspace("ref", reference), tests), { code: 0, passed: 3, expected: 3, error: null, verdict: "pass", plain: "3/3" });
  const starter = grade(workspace("starter"), tests);
  assert.equal(starter.code, 1);
  assert.ok(starter.passed < starter.expected);
});

test("exit-code and process cheats fail", { skip: !PY && "no python3 >= 3.10" }, () => {
  const cheats = {
    "os-exit": "import os\nos._exit(0)\n",
    "sys-exit": "import sys\nsys.exit(0)\n",
    // unittest is patched in the candidate's own process only; the tests run elsewhere.
    "patch-unittest": "import unittest\nunittest.TestCase.run = lambda self, result=None: None\nunittest.TestResult.wasSuccessful = lambda self: True\n",
    // Results live in the test runner's dir. In --local mode the candidate runs as the same user and can
    // write it (it is ../out from the candidate's cwd, on any platform); the runner then can't create its
    // file, exits 1, and grade.py ignores a results file next to a failed runner. Only its own job dir:
    // other gradings may be running in parallel. In the guest the dir is grader-only (vm.test.ts).
    "fake-results": "import json, os\ntry:\n    open(os.path.join(os.getcwd(), '..', 'out', 'results.json'), 'w').write(json.dumps({'expected': 3, 'passed': 3}))\nexcept OSError:\n    pass\nprint('PASS')\n",
  };
  for (const [name, prefix] of Object.entries(cheats)) {
    const starter = readFileSync(join(CASE, "workspace/pagination.py"), "utf8");
    const r = grade(workspace(name, prefix + starter), tests);
    assert.equal(r.code, 1, `${name} passed: ${JSON.stringify(r)}`);
    assert.notEqual(r.verdict, "pass", name);
    assert.ok(r.expected === 0 || r.passed < r.expected, `${name}: ${JSON.stringify(r)}`);
    if (name === "fake-results") assert.match(r.error ?? "", /results file ignored/);
  }
  const exitBeforeReference = grade(workspace("ref-exit", `import os\nos._exit(0)\n${reference}`), tests);
  assert.equal(exitBeforeReference.code, 1);
  assert.match(exitBeforeReference.error ?? "", /candidate process ended|loading the tests failed/);
});

/** A coding case's workspace with its reference solution copied over, then `edit` applied to one file. */
function caseWorkspace(name: string, caseId: string, edit?: { file: string; change: (s: string) => string }): { ws: string; tests: string } {
  const ws = join(tmp, name);
  cpSync(join(REPO_DIR, "evals/cases/coding", caseId, "workspace"), ws, { recursive: true });
  cpSync(join(REPO_DIR, "evals/reference/coding", caseId), ws, { recursive: true });
  if (edit) {
    const before = readFileSync(join(ws, edit.file), "utf8");
    const after = edit.change(before);
    assert.notEqual(after, before, `edit of ${edit.file} changed nothing`);
    writeFileSync(join(ws, edit.file), after);
  }
  return { ws, tests: join(REPO_DIR, "evals/cases/coding", caseId, "grader/test_hidden.py") };
}

test("fix-inventory: a Warehouse that keeps and changes the caller's dict fails, as in one process (review 2, #1)", { skip: !PY && "no python3 >= 3.10" }, () => {
  const ref = caseWorkspace("inv-ref", "fix-inventory");
  assert.deepEqual(grade(ref.ws, ref.tests), { code: 0, passed: 6, expected: 6, error: null, verdict: "pass", plain: "6/6" });
  const alias = caseWorkspace("inv-alias", "fix-inventory", {
    file: "inventory/service.py",
    change: (s) => s.replace("self.stock = dict(stock or {})", "self.stock = stock if stock is not None else {}"),
  });
  const r = grade(alias.ws, alias.tests);
  assert.deepEqual(r, { code: 1, passed: 5, expected: 6, error: null, verdict: "fail", plain: "5/6" });
  // Plain unittest on the same files agrees.
  const plain = spawnSync(PY!, ["-m", "unittest", "test_hidden"], { cwd: alias.ws, encoding: "utf8", env: { ...process.env, PYTHONPATH: dirname(alias.tests), PYTHONDONTWRITEBYTECODE: "1" } });
  assert.match(plain.stderr, /FAILED \(failures=1\)/);
  assert.match(plain.stderr, /test_caller_dict_not_mutated/);
});

test("refactor-report: rewriting report.py from candidate code doesn't change the source the tests read (review 2, #2)", { skip: !PY && "no python3 >= 3.10" }, () => {
  const ref = caseWorkspace("refactor-ref", "refactor-report");
  assert.deepEqual(grade(ref.ws, ref.tests), { code: 0, passed: 3, expected: 3, error: null, verdict: "pass", plain: "3/3" });
  const refactored = readFileSync(join(ref.ws, "report.py"), "utf8");
  // The original loops plus the helper, and on import the module overwrites its own file with the refactor.
  const starter = readFileSync(join(REPO_DIR, "evals/cases/coding/refactor-report/workspace/report.py"), "utf8");
  const helper = refactored.slice(refactored.indexOf("def _summarize"), refactored.indexOf("def revenue_by_region"));
  const cheat = `${starter}\n\n${helper}\nwith open(__file__, "w", encoding="utf-8") as _f:\n    _f.write(${JSON.stringify(refactored)})\n`;
  const swap = caseWorkspace("refactor-swap", "refactor-report", { file: "report.py", change: () => cheat });
  const r = grade(swap.ws, swap.tests);
  assert.deepEqual(r, { code: 1, passed: 2, expected: 3, error: null, verdict: "fail", plain: "2/3" });
});

test("a candidate object that claims to equal anything does not pass", { skip: !PY && "no python3 >= 3.10" }, () => {
  const always = "class Any:\n    def __eq__(self, other):\n        return True\n    __hash__ = object.__hash__\n\ndef paginate(items, page, per_page):\n    if page < 1 or per_page < 1:\n        raise ValueError\n    return Any()\n\ndef total_pages(n, per_page):\n    if per_page < 1:\n        raise ValueError\n    return Any()\n";
  const r = grade(workspace("any", always), tests);
  assert.equal(r.code, 1);
  assert.equal(r.passed, 1, "only the ValueError test passes"); // test_invalid
  // Plain unittest believes it: the runs disagree, a grader error.
  assert.deepEqual([r.verdict, r.plain], ["disagree", "3/3"]);
});

test("MBPP harness: built-ins stay local even if the candidate redefines them", { skip: !PY && "no python3 >= 3.10" }, () => {
  const rec = { task_id: 1, prompt: "Return the set of xs.", code: "def uniq(xs):\n    return sorted(set(xs))\n", test_imports: [], test_list: ["assert set(uniq([1, 1, 2])) == {1, 2}", "assert sys.getsizeof(1) > 0"] };
  const [item] = convertMbpp(Buffer.from(JSON.stringify([rec])));
  const base = join(tmp, "mbpp");
  for (const f of [...item!.case.setupFiles!, ...item!.case.hiddenFiles!]) {
    const p = f.path.replace(/^\/workspace\//, `${base}/ws/`).replace(/^\/grader\//, `${base}/gr/`);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.content);
  }
  writeFileSync(join(base, "ws/solution.py"), item!.reference!.content);
  assert.equal(grade(join(base, "ws"), join(base, "gr/test_hidden.py")).code, 0);
  const forged = "class Any:\n    def __eq__(self, o):\n        return True\n    __hash__ = object.__hash__\n\ndef set(*a):\n    return Any()\n\ndef uniq(xs):\n    return []\n";
  writeFileSync(join(base, "ws/solution.py"), forged);
  const r = grade(join(base, "ws"), join(base, "gr/test_hidden.py"));
  assert.equal(r.code, 1);
  assert.equal(r.passed, 1); // the getsizeof test
  assert.notEqual(r.verdict, "pass");
});

test("dual grading: an early zero exit cannot supply a plain result", { skip: !PY && "no python3 >= 3.10" }, () => {
  // The isolated candidate dies at import. In the plain run os._exit is guarded, so loading fails and the
  // out-of-process observer receives a real failure rather than accepting the process status as a verdict.
  const forge = "import json, os\ntry:\n    open(os.path.join(os.getcwd(), '..', 'out', 'results.json'), 'w').write(json.dumps({'expected': 3, 'passed': 3, 'failures': [], 'error': None}))\nexcept OSError:\n    pass\nos._exit(0)\n";
  const { r, summary } = gradeFull(workspace("forge-plain", forge + reference), tests);
  assert.equal(r.code, 1);
  assert.notEqual(r.verdict, "pass");
  assert.notEqual(summary.plain?.error, null);
  const g = testsGrade(summary, r.code);
  assert.equal(g.pass, false);
});

test("plain observer rejects a forged socket report followed by os._exit", { skip: !PY && "no python3 >= 3.10" }, () => {
  // std_instance_state is one of the former known-lenient cases: isolated passes while honest plain fails.
  // The prefix targets only the plain process, writes a complete fake report to every socket it can find,
  // and attempts to exit 0. Without the exit guard the root observer would receive only that forged JSON.
  const source = join(REPO_DIR, "qa/review6-cases/std_instance_state");
  const ws = join(tmp, "socket-report-forge");
  cpSync(source, ws, { recursive: true });
  rmSync(join(ws, "tests.py"));
  const prefix = [
    "import os as _o, stat as _st, sys as _s",
    "if 'test_hidden' in _s.modules:",
    "    _fake = b'{\\\"expected\\\":2,\\\"passed\\\":2,\\\"failures\\\":[],\\\"error\\\":null}'",
    "    for _fd in range(3, 64):",
    "        try:",
    "            if _st.S_ISSOCK(_o.fstat(_fd).st_mode): _o.write(_fd, _fake)",
    "        except OSError: pass",
    "    _o._exit(0)",
    "",
  ].join("\n");
  writeFileSync(join(ws, "m.py"), prefix + readFileSync(join(source, "m.py"), "utf8"));
  const { r, summary } = gradeFull(ws, join(source, "tests.py"));
  assert.equal(summary.passed, summary.expected, "the isolated run remains the known-lenient pass");
  assert.equal(r.code, 1);
  assert.notEqual(r.verdict, "pass");
  assert.match(summary.plain?.error ?? "", /unreadable|exited|protected/);
});

test("plain observer hides runner frames from candidate signal handlers", { skip: !PY && "no python3 >= 3.10" }, () => {
  const source = join(REPO_DIR, "qa/review6-cases/std_instance_state");
  const ws = join(tmp, "signal-frame-forge");
  cpSync(source, ws, { recursive: true });
  rmSync(join(ws, "tests.py"));
  const prefix = [
    "import signal as _sig, sys as _sys, unittest as _u",
    "_plain = 'test_hidden' in _sys.modules",
    "if _plain:",
    "    def _forge(signum, frame):",
    "        while frame is not None:",
    "            for value in tuple(frame.f_locals.values()):",
    "                result = getattr(value, 'res', None)",
    "                if isinstance(result, _u.TestResult) and hasattr(result, 'passed'):",
    "                    result.passed[:] = ['forged', 'forged']",
    "                    return",
    "            frame = frame.f_back",
    "    _sig.signal(_sig.SIGALRM, _forge)",
    "",
  ].join("\n");
  const suffix = "\n_original_month_rows = month_rows\ndef month_rows(y, mth):\n    if _plain: _sig.raise_signal(_sig.SIGALRM)\n    return _original_month_rows(y, mth)\n";
  writeFileSync(join(ws, "m.py"), prefix + readFileSync(join(source, "m.py"), "utf8") + suffix);
  const { r, summary } = gradeFull(ws, join(source, "tests.py"));
  assert.equal(summary.passed, summary.expected, "the isolated run remains the known-lenient pass");
  assert.equal(r.code, 1);
  assert.equal(r.verdict, "disagree");
  assert.equal(summary.plain?.passed, 0);
  assert.ok((summary.plain?.failures?.length ?? 0) > 0, "the real plain failures remain visible");
});

test("dual grading: an int subclass that equals anything passes plain unittest but not the isolated run", { skip: !PY && "no python3 >= 3.10" }, () => {
  const lenient = `${reference}\n\nclass _Lenient(int):\n    def __eq__(self, other):\n        return True\n    __hash__ = int.__hash__\n\n\n_real_total_pages = total_pages\n\n\ndef total_pages(n, per_page):\n    _real_total_pages(n, per_page)\n    return _Lenient(0)\n`;
  const { r, summary } = gradeFull(workspace("lenient", lenient), tests);
  assert.equal(r.code, 1);
  assert.equal(r.plain, "3/3");
  assert.equal(r.verdict, "disagree");
  assert.ok(r.passed < r.expected, JSON.stringify(r));
  assert.equal(testsGrade(summary, r.code).error, true);
});

test("refactor-report: a symlinked source rewritten by candidate code is not what the tests read (review 3, #2)", { skip: !PY && "no python3 >= 3.10" }, () => {
  const ref = caseWorkspace("symlink-ref", "refactor-report");
  const refactored = readFileSync(join(ref.ws, "report.py"), "utf8");
  const starter = readFileSync(join(REPO_DIR, "evals/cases/coding/refactor-report/workspace/report.py"), "utf8");
  const helper = refactored.slice(refactored.indexOf("def _summarize"), refactored.indexOf("def revenue_by_region"));
  // report.py is an absolute link to a file outside the workspace; on import the module rewrites it (through
  // the link) with the refactor. Copies that follow the link would show the tests the rewritten file.
  const outside = join(tmp, "symlink-outside.py");
  writeFileSync(outside, `${starter}\n\n${helper}\nwith open(__file__, "w", encoding="utf-8") as _f:\n    _f.write(${JSON.stringify(refactored)})\n`);
  const swap = caseWorkspace("symlink-swap", "refactor-report");
  rmSync(join(swap.ws, "report.py"));
  symlinkSync(outside, join(swap.ws, "report.py"));
  const r = grade(swap.ws, swap.tests);
  assert.equal(readFileSync(outside, "utf8"), refactored, "the cheat ran");
  assert.deepEqual(r, { code: 1, passed: 2, expected: 3, error: null, verdict: "fail", plain: "2/3" });
});

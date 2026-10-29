// The VM test grader (guest grade.py) run host-side in --local mode: candidate code and hidden tests in
// separate processes. The cheats from review 1 (#1) must fail while the reference solution passes. The
// uid split, kills and copy are covered in the guest by vm.test.ts.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { REPO_DIR } from "../config.ts";
import { HOST_HELPERS_DIR } from "../envs/vm/driver.ts";
import { convertMbpp } from "./suites/convert.ts";

const GRADE = join(HOST_HELPERS_DIR, "grade.py");
const CASE = join(REPO_DIR, "evals/cases/coding/fix-pagination");
const has = (p: string) => spawnSync(p, ["-c", "import sys; assert sys.version_info >= (3, 10)"], { stdio: "ignore" }).status === 0;
const PY = process.env.TERRARIUM_PY || ["python3.12", "python3.13", "python3"].find(has);
const tmp = mkdtempSync(join(tmpdir(), "terr-gradelocal-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

function grade(ws: string, tests: string): { code: number; passed: number; expected: number; error: string | null } {
  const r = spawnSync(PY!, ["-I", "-S", GRADE, "--local", "--tests", tests, "--workspace", ws, "--timeout", "60"], { encoding: "utf8", timeout: 90_000 });
  const j = JSON.parse(r.stdout.trim().split("\n").pop() || "{}") as { passed?: number; expected?: number; error?: string | null };
  return { code: r.status ?? -1, passed: j.passed ?? 0, expected: j.expected ?? 0, error: j.error ?? null };
}

function workspace(name: string, solution?: string): string {
  const ws = join(tmp, name);
  cpSync(join(CASE, "workspace"), ws, { recursive: true });
  if (solution !== undefined) writeFileSync(join(ws, "pagination.py"), solution);
  return ws;
}

const reference = readFileSync(join(REPO_DIR, "evals/reference/coding/fix-pagination/pagination.py"), "utf8");
const tests = join(CASE, "grader/test_hidden.py");

test("reference passes; starter fails", { skip: !PY && "no python3 >= 3.10" }, () => {
  assert.deepEqual(grade(workspace("ref", reference), tests), { code: 0, passed: 3, expected: 3, error: null });
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
    // Results live in the test runner's dir; anything the candidate writes is ignored.
    "fake-results": "import glob, json, os\nfor d in glob.glob('/tmp/terrarium-grade-*/out') + glob.glob('/var/lib/terrarium-grade/*/out'):\n    try:\n        open(os.path.join(d, 'results.json'), 'w').write(json.dumps({'expected': 3, 'passed': 3}))\n    except OSError:\n        pass\nprint('PASS')\n",
  };
  for (const [name, prefix] of Object.entries(cheats)) {
    const starter = readFileSync(join(CASE, "workspace/pagination.py"), "utf8");
    const r = grade(workspace(name, prefix + starter), tests);
    assert.equal(r.code, 1, `${name} passed: ${JSON.stringify(r)}`);
    assert.ok(r.expected === 0 || r.passed < r.expected, name);
  }
  const exitBeforeReference = grade(workspace("ref-exit", `import os\nos._exit(0)\n${reference}`), tests);
  assert.equal(exitBeforeReference.code, 1);
  assert.match(exitBeforeReference.error ?? "", /candidate process ended|loading the tests failed/);
});

test("a candidate object that claims to equal anything does not pass", { skip: !PY && "no python3 >= 3.10" }, () => {
  const always = "class Any:\n    def __eq__(self, other):\n        return True\n    __hash__ = object.__hash__\n\ndef paginate(items, page, per_page):\n    if page < 1 or per_page < 1:\n        raise ValueError\n    return Any()\n\ndef total_pages(n, per_page):\n    if per_page < 1:\n        raise ValueError\n    return Any()\n";
  const r = grade(workspace("any", always), tests);
  assert.equal(r.code, 1);
  assert.equal(r.passed, 1, "only the ValueError test passes"); // test_invalid
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
});

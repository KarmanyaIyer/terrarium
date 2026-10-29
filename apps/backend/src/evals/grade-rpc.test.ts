// The grading RPC (guest grade_rpc.py) must look like one process to a hidden test: the same suite gives the
// same verdict as plain unittest. Run through grade.py --local; each case is a small module plus a hidden test.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { HOST_HELPERS_DIR } from "../envs/vm/driver.ts";

const GRADE = join(HOST_HELPERS_DIR, "grade.py");
const has = (p: string) => spawnSync(p, ["-c", "import sys; assert sys.version_info >= (3, 10)"], { stdio: "ignore" }).status === 0;
const PY = process.env.TERRARIUM_PY || ["python3.12", "python3.13", "python3"].find(has);
const skip = !PY && "no python3 >= 3.10";
const tmp = mkdtempSync(join(tmpdir(), "terr-graderpc-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

interface Result {
  code: number;
  passed: number;
  expected: number;
  error: string | null;
  failures: { test: string; kind: string; message: string }[];
  verdict: string;
  /** The plain unittest run's counts, "passed/expected". */
  plain: string;
}

let n = 0;
/** Grades `files` (the workspace) against a hidden unittest body; `tests` is indented test methods. */
function grade(files: Record<string, string>, tests: string, timeout = 60): Result {
  const base = join(tmp, String(++n));
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(dirname(join(base, "ws", p)), { recursive: true });
    writeFileSync(join(base, "ws", p), content);
  }
  const hidden = join(base, "test_hidden.py");
  writeFileSync(hidden, `import unittest\nimport m\n\n\nclass Hidden(unittest.TestCase):\n${tests}\n`);
  const r = spawnSync(PY!, ["-I", "-S", GRADE, "--local", "--tests", hidden, "--workspace", join(base, "ws"), "--timeout", String(timeout)], { encoding: "utf8", timeout: (2 * timeout + 30) * 1000 });
  const j = JSON.parse(r.stdout.trim().split("\n").pop() || "{}") as Partial<Omit<Result, "plain">> & { plain?: { passed?: number; expected?: number } };
  const plain = `${j.plain?.passed ?? "?"}/${j.plain?.expected ?? "?"}`;
  return { code: r.status ?? -1, passed: j.passed ?? 0, expected: j.expected ?? 0, error: j.error ?? null, failures: j.failures ?? [], verdict: j.verdict ?? "?", plain };
}

const failed = (r: Result) => r.failures.map((f) => f.test).sort();

test("a function that mutates its arguments is seen by the caller (review 2, #1)", { skip }, () => {
  const mod = [
    "def push(xs, v):",
    "    xs.append(v)",
    "",
    "def fill(d):",
    "    d['inner'].append(9)",
    "    d['new'] = {1, 2}",
    "",
    "def same(x):",
    "    return x",
    "",
    "def twice(a, b):",
    "    a.append(1)",
    "    return a is b",
    "",
    "def fail_after(xs):",
    "    xs.append('partial')",
    "    raise ValueError('no')",
    "",
    "def calls_back(xs, cb):",
    "    xs.append(1)",
    "    return cb()",
    "",
    "def grow(b):",
    "    b.extend(b'!')",
    "",
  ].join("\n");
  const r = grade({ "m.py": mod }, [
    "    def test_inplace(self):",
    "        xs = [1]",
    "        self.assertIsNone(m.push(xs, 2))",
    "        self.assertEqual(xs, [1, 2])",
    "    def test_nested(self):",
    "        inner = [1]",
    "        d = {'inner': inner}",
    "        m.fill(d)",
    "        self.assertIs(d['inner'], inner)",
    "        self.assertEqual(inner, [1, 9])",
    "        self.assertEqual(d['new'], {1, 2})",
    "    def test_identity_and_aliases(self):",
    "        xs = [3]",
    "        self.assertIs(m.same(xs), xs)",
    "        self.assertTrue(m.twice(xs, xs))",
    "        self.assertEqual(xs, [3, 1])",
    "    def test_cycle(self):",
    "        xs = [1]",
    "        xs.append(xs)",
    "        self.assertIs(m.same(xs), xs)",
    "    def test_mutation_before_raise(self):",
    "        xs = []",
    "        with self.assertRaises(ValueError):",
    "            m.fail_after(xs)",
    "        self.assertEqual(xs, ['partial'])",
    "    def test_callback_sees_mutation(self):",
    "        xs = []",
    "        self.assertEqual(m.calls_back(xs, lambda: len(xs)), 1)",
    "    def test_bytearray(self):",
    "        b = bytearray(b'hi')",
    "        m.grow(b)",
    "        self.assertEqual(b, bytearray(b'hi!'))",
  ].join("\n"));
  assert.deepEqual({ code: r.code, passed: r.passed, expected: r.expected, failed: failed(r) }, { code: 0, passed: 7, expected: 7, failed: [] });
});

test("an object that keeps a caller's container and changes it later is seen (review 2, #1)", { skip }, () => {
  const mod = [
    "class Box:",
    "    def __init__(self, items):",
    "        self.items = items  # keeps the caller's list",
    "    def add(self, v):",
    "        self.items.append(v)",
    "    def size(self):",
    "        return len(self.items)",
    "",
    "class Copying:",
    "    def __init__(self, items):",
    "        self.items = list(items)",
    "    def add(self, v):",
    "        self.items.append(v)",
    "",
  ].join("\n");
  const r = grade({ "m.py": mod }, [
    "    def test_alias(self):",
    "        xs = [1]",
    "        b = m.Box(xs)",
    "        b.add(2)",
    "        self.assertEqual(xs, [1, 2])",
    "        self.assertIs(b.items, xs)",
    "    def test_resend_carries_test_changes(self):",
    "        xs = [1]",
    "        b = m.Box(xs)",
    "        xs.append(5)",
    "        b.items = xs",
    "        self.assertEqual(b.size(), 2)",
    "    def test_copy_leaves_caller_alone(self):",
    "        xs = [1]",
    "        c = m.Copying(xs)",
    "        c.add(2)",
    "        self.assertEqual(xs, [1])",
  ].join("\n"));
  assert.deepEqual({ code: r.code, passed: r.passed, expected: r.expected, failed: failed(r) }, { code: 0, passed: 3, expected: 3, failed: [] });
});

test("subclasses of built-in data types keep their class, methods and attributes (review 2, #12)", { skip }, () => {
  const mod = [
    "from collections import OrderedDict, namedtuple",
    "from enum import IntEnum",
    "",
    "class Stack(list):",
    "    def push(self, v):",
    "        self.append(v)",
    "    def peek(self):",
    "        return self[-1]",
    "",
    "class Cache(OrderedDict):",
    "    def get(self, key, default=None):",
    "        if key in self:",
    "            self.move_to_end(key, last=False)",
    "        return super().get(key, default)",
    "",
    "Point = namedtuple('Point', 'x y')",
    "",
    "class Color(IntEnum):",
    "    RED = 1",
    "",
    "def point():",
    "    return Point(1, 2)",
    "",
  ].join("\n");
  const r = grade({ "m.py": mod }, [
    "    def test_list_subclass(self):",
    "        s = m.Stack()",
    "        s.push(1)",
    "        self.assertEqual(s, [1])",
    "        s.push(2)",
    "        self.assertEqual(s, [1, 2])",
    "        self.assertEqual(s.peek(), 2)",
    "        self.assertEqual(len(s), 2)",
    "        self.assertIsInstance(s, list)",
    "        self.assertIsInstance(s, m.Stack)",
    "        self.assertEqual(type(s).__name__, 'Stack')",
    "    def test_ordered_dict_subclass(self):",
    "        c = m.Cache()",
    "        c['a'] = 1",
    "        c['b'] = 2",
    "        self.assertEqual(c.get('b'), 2)",
    "        self.assertEqual(list(c), ['b', 'a'])",
    "        self.assertIn('a', c)",
    "        self.assertEqual(c, {'a': 1, 'b': 2})",
    "    def test_namedtuple(self):",
    "        p = m.point()",
    "        self.assertEqual(p, (1, 2))",
    "        self.assertEqual((p.x, p.y), (1, 2))",
    "        self.assertEqual(p._replace(x=5), (5, 2))",
    "        self.assertIn(p, {(1, 2)})",
    "    def test_int_enum(self):",
    "        self.assertEqual(m.Color.RED, 1)",
    "        self.assertEqual(m.Color.RED.name, 'RED')",
  ].join("\n"));
  assert.deepEqual({ code: r.code, passed: r.passed, expected: r.expected, failed: failed(r) }, { code: 0, passed: 4, expected: 4, failed: [] });
});

test("a hybrid's candidate __eq__ can't claim a match on its own; an overridden __contains__ runs as in one process (review 2, #12; review 3, #1)", { skip }, () => {
  const mod = "class Liar(list):\n    def __eq__(self, other):\n        return True\n    def __contains__(self, item):\n        return True\n    __hash__ = None\n\ndef answer():\n    return Liar([0])\n";
  const r = grade({ "m.py": mod }, "    def test_value(self):\n        self.assertEqual(m.answer(), [42])\n    def test_member(self):\n        self.assertIn(42, m.answer())\n");
  // Plain unittest passes both. In the isolated run __eq__ needs the local data to agree, so test_value fails
  // there: the runs disagree. __contains__ is the candidate's in both.
  assert.deepEqual({ code: r.code, passed: r.passed, failed: failed(r), verdict: r.verdict, plain: r.plain }, { code: 1, passed: 1, failed: ["test_value"], verdict: "disagree", plain: "2/2" });
});

test("a class name the test side can't use as a type name is a grader error, not a ValueError", { skip }, () => {
  const mod = "class Odd(Exception):\n    pass\n\nOdd.__qualname__ = 'Odd\\x00'\n\ndef f():\n    return Odd\n";
  const r = grade({ "m.py": mod }, "    def test_raises(self):\n        with self.assertRaises(ValueError):\n            m.f()\n");
  assert.equal(r.code, 1, JSON.stringify(r));
  assert.equal(r.passed, 0);
});

test("slices reach candidate objects; an OrderedDict keeps its order on the way in", { skip }, () => {
  const mod = "class Stack(list):\n    pass\n\ndef make():\n    return Stack([1, 2, 3])\n\ndef keys(d):\n    return list(d)\n";
  const r = grade({ "m.py": mod }, [
    "    def test_slice(self):",
    "        self.assertEqual(m.make()[1:], [2, 3])",
    "    def test_order(self):",
    "        from collections import OrderedDict",
    "        d = OrderedDict(a=1, b=2)",
    "        d.move_to_end('a')",
    "        self.assertEqual(m.keys(d), ['b', 'a'])",
  ].join("\n"));
  assert.deepEqual({ code: r.code, passed: r.passed, failed: failed(r) }, { code: 0, passed: 2, failed: [] });
});

test("a value too deep to send is a grader error, not a ValueError the test can expect (review 2, #12)", { skip }, () => {
  const mod = "def deep():\n    x = []\n    for _ in range(300):\n        x = [x]\n    return x\n";
  const r = grade({ "m.py": mod }, [
    "    def test_value_error(self):",
    "        with self.assertRaises(ValueError):",
    "            m.deep()",
    "    def test_any_exception(self):",
    "        with self.assertRaises(Exception):",
    "            m.deep()",
  ].join("\n"));
  assert.equal(r.code, 1);
  assert.equal(r.passed, 0, JSON.stringify(r));
  assert.ok(r.failures.every((f) => f.kind === "error" && /Unsendable/.test(f.message)), JSON.stringify(r.failures));
});

test("grader failures are never caught by assertRaises: a dead candidate and unsendable test values", { skip }, () => {
  const mod = "import os\n\ndef check(x):\n    if x < 0:\n        os._exit(0)\n    return x\n\ndef accept(x):\n    return None\n";
  const r = grade({ "m.py": mod }, [
    "    def test_negative_raises(self):",
    "        with self.assertRaises(Exception):",
    "            m.check(-1)",
  ].join("\n"));
  assert.equal(r.code, 1, JSON.stringify(r));
  assert.equal(r.passed, 0);
  const sent = grade({ "m.py": mod }, [
    "    def test_type_error(self):",
    "        with self.assertRaises(TypeError):",
    "            m.accept(object())",
  ].join("\n"));
  assert.equal(sent.code, 1, JSON.stringify(sent));
  assert.equal(sent.passed, 0);
});

test("a candidate class named builtins.ValueError is not the real ValueError (review 2, #12)", { skip }, () => {
  const mod = "class ValueError(Exception):\n    pass\n\nValueError.__module__ = 'builtins'\n\ndef f():\n    raise ValueError('fake')\n";
  const r = grade({ "m.py": mod }, "    def test_raises(self):\n        with self.assertRaises(ValueError):\n            m.f()\n");
  assert.equal(r.code, 1);
  assert.equal(r.passed, 0);
  assert.match(r.failures[0]?.message ?? "", /ValueError: fake/);
});

test("candidate attributes named like the proxy's internals are the candidate's", { skip }, () => {
  const mod = "class Order:\n    def __init__(self):\n        self._id = 7\n        self._c = 'c'\n        self._req = 'r'\n";
  const r = grade({ "m.py": mod }, "    def test_attrs(self):\n        o = m.Order()\n        self.assertEqual((o._id, o._c, o._req), (7, 'c', 'r'))\n");
  assert.deepEqual({ code: r.code, passed: r.passed }, { code: 0, passed: 1 });
});

test("one candidate call may use the whole grading time, and a hang still reports per-test results (review 2, #12)", { skip }, () => {
  const mod = "import time\n\ndef slow():\n    time.sleep(31)\n    return 1\n\ndef hang():\n    time.sleep(3600)\n\ndef quick():\n    return 2\n";
  const slow = grade({ "m.py": mod }, "    def test_slow(self):\n        self.assertEqual(m.slow(), 1)\n", 50);
  assert.deepEqual({ code: slow.code, passed: slow.passed, error: slow.error }, { code: 0, passed: 1, error: null });
  const hung = grade({ "m.py": mod }, "    def test_a_quick(self):\n        self.assertEqual(m.quick(), 2)\n    def test_b_hang(self):\n        m.hang()\n", 8);
  assert.deepEqual({ code: hung.code, passed: hung.passed, expected: hung.expected }, { code: 1, passed: 1, expected: 2 });
  assert.match(hung.failures[0]?.message ?? "", /grading deadline/);
});

test("namedtuple and defaultdict arguments keep their types, NaNs keep their identities (review 3, #9)", { skip }, () => {
  const mod = [
    "import math",
    "",
    "def shift(p):",
    "    return p._replace(x=p.x + 1), type(p).__name__, p._fields",
    "",
    "def tally(d, words):",
    "    for w in words:",
    "        d[w].append(len(w))",
    "    return type(d).__name__, d.default_factory is list",
    "",
    "def nans():",
    "    return [float('nan'), float('nan')]",
    "",
    "def same(xs):",
    "    return xs[0] is xs[1], math.isnan(xs[0])",
    "",
  ].join("\n");
  const r = grade({ "m.py": mod }, [
    "    def test_namedtuple_arg(self):",
    "        from collections import namedtuple",
    "        P = namedtuple('P', 'x y')",
    "        moved, name, fields = m.shift(P(1, 2))",
    "        self.assertEqual((name, fields), ('P', ('x', 'y')))",
    "        self.assertEqual(moved, P(2, 2))",
    "        self.assertIsInstance(moved, P)",
    "    def test_defaultdict_arg(self):",
    "        from collections import defaultdict",
    "        d = defaultdict(list)",
    "        self.assertEqual(m.tally(d, ['ab', 'c', 'ab']), ('defaultdict', True))",
    "        self.assertEqual(dict(d), {'ab': [2, 2], 'c': [1]})",
    "        self.assertIs(d.default_factory, list)",
    "    def test_separate_nans(self):",
    "        a, b = m.nans()",
    "        self.assertIsNot(a, b)",
    "        self.assertEqual(len({a, b}), 2)",
    "    def test_one_nan_twice(self):",
    "        x = float('nan')",
    "        self.assertEqual(m.same([x, x]), (True, True))",
    "        self.assertEqual(m.same([x, float('nan')]), (False, True))",
  ].join("\n"));
  assert.deepEqual({ code: r.code, passed: r.passed, expected: r.expected, failed: failed(r), verdict: r.verdict, plain: r.plain }, { code: 0, passed: 4, expected: 4, failed: [], verdict: "pass", plain: "4/4" });
});

test("more than 50 failures: the first 50 are listed and the rest counted (review 3, #9)", { skip }, () => {
  const methods = Array.from({ length: 60 }, (_, i) => `    def test_${String(i).padStart(2, "0")}(self):\n        self.assertEqual(m.f(), ${i + 1})`).join("\n");
  const base = join(tmp, "many");
  mkdirSync(join(base, "ws"), { recursive: true });
  writeFileSync(join(base, "ws/m.py"), "def f():\n    return 0\n");
  writeFileSync(join(base, "test_hidden.py"), `import unittest\nimport m\n\n\nclass Hidden(unittest.TestCase):\n${methods}\n`);
  const p = spawnSync(PY!, ["-I", "-S", GRADE, "--local", "--tests", join(base, "test_hidden.py"), "--workspace", join(base, "ws"), "--timeout", "60"], { encoding: "utf8", timeout: 150_000 });
  const j = JSON.parse(p.stdout.trim().split("\n").pop() || "{}") as { failures?: unknown[]; moreFailures?: number; plain?: { failures?: unknown[]; moreFailures?: number }; verdict?: string };
  assert.deepEqual([j.failures?.length, j.moreFailures, j.plain?.failures?.length, j.plain?.moreFailures, j.verdict], [50, 10, 50, 10, "fail"]);
});

"""Test side of a grading run. Loads the hidden unittest file, runs it, and writes the counts to --results.

Isolated (default; uid 1001 in the guest, `python3 -I -S`): imports of the candidate's modules resolve to
proxies into the candidate process (--fd); no candidate code ever runs in this process, and --results is in
a grader-only dir.

Plain (--plain; uid 1000 in the guest, after the isolated run has finished): ordinary unittest in one
process, candidate modules imported from the working directory. Exact Python semantics, no protection: the
candidate's code can change these counts, which is why a pass needs both runs.

Hidden tests can `import terrarium_grading` for `workspace` (a copy of the workspace taken before any
candidate code ran, root-owned and read-only in the guest, for reading the candidate's source) and
`stdlib(name)` (import a standard-library module locally)."""

import importlib.abc
import importlib.machinery
import importlib.util
import json
import os
import re
import socket
import sys
import threading
import time
import traceback
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from grade_rpc import CandidateGone, Client, Ref  # noqa: E402

sys.path.remove(HERE)


class ProxyModule(types.ModuleType):
    """A candidate module: attribute reads go to the candidate process."""

    def __getattr__(self, name):
        ref = self.__dict__.get("_terrarium_ref")
        if ref is None or (name.startswith("__") and name.endswith("__")):
            raise AttributeError(name)
        return getattr(ref, name)


class CandidateLoader(importlib.abc.Loader):
    def __init__(self, client):
        self.client = client

    def create_module(self, spec):
        return ProxyModule(spec.name)

    def exec_module(self, module):
        ref = self.client.request("import", name=module.__name__)
        if not isinstance(ref, Ref):
            raise ImportError("candidate module %s did not load" % module.__name__)
        module.__dict__["_terrarium_ref"] = ref


class CandidateFinder(importlib.abc.MetaPathFinder):
    def __init__(self, client, names):
        self.loader = CandidateLoader(client)
        self.names = set(names)

    def find_spec(self, fullname, path=None, target=None):
        if fullname.split(".")[0] not in self.names:
            return None
        return importlib.machinery.ModuleSpec(fullname, self.loader, is_package=True)


class Recorder(unittest.TextTestResult):
    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.passed = []
        self.current = None

    def startTest(self, test):
        self.current = test.id().rsplit(".", 1)[-1]
        super().startTest(test)

    def addSuccess(self, test):
        super().addSuccess(test)
        self.passed.append(test.id())


def short(err):
    lines = "".join(traceback.format_exception_only(err[0], err[1])).strip().splitlines()
    return (lines[-1] if lines else err[0].__name__)[:300]


EXC_LINE = re.compile(r"^[A-Za-z_][\w.]*(Error|Exception|Exit|Interrupt|Warning|CandidateGone|Unsendable)\b")


def summary(tb, kind):
    """The exception line of a traceback ("AssertionError: 'IV' != 'IIII'"), not a diff's trailing hint."""
    lines = [ln for ln in tb.strip().splitlines() if ln.strip()]
    hits = [ln for ln in lines if EXC_LINE.match(ln)]
    return (hits[-1] if hits else lines[-1] if lines else kind)[:300]


class Results:
    """Counts so far; written once, by whichever comes first: the end of the run or (--plain) the deadline."""

    def __init__(self, path):
        self.path = path
        self.out = {"expected": 0, "passed": 0, "failures": [], "error": None}
        self.res = None
        self.lock = threading.Lock()
        self.written = False

    def collect(self):
        out = dict(self.out, failures=list(self.out["failures"]))
        res = self.res
        if res is not None:
            out["passed"] = len(res.passed)
            out["failures"] = []
            for kind, items in (("fail", res.failures), ("error", res.errors)):
                for test, tb in items:
                    out["failures"].append({"test": test.id().rsplit(".", 1)[-1], "kind": kind, "message": summary(tb, kind)})
            for test, why in res.skipped:
                out["failures"].append({"test": test.id().rsplit(".", 1)[-1], "kind": "skipped", "message": str(why)[:300]})
        return out

    def write(self, extra):
        with self.lock:
            if self.written:
                return False
            self.written = True
        out = self.collect()
        out.update(extra)
        fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(out, f)
        return True


def run_tests(tests, results):
    """Load and run the hidden tests, recording into results."""
    try:
        spec = importlib.util.spec_from_file_location("test_hidden", tests)
        mod = importlib.util.module_from_spec(spec)
        sys.modules["test_hidden"] = mod
        spec.loader.exec_module(mod)
        suite = unittest.defaultTestLoader.loadTestsFromModule(mod)
        results.out["expected"] = suite.countTestCases()
        runner = unittest.TextTestRunner(stream=sys.stderr, verbosity=2, resultclass=Recorder)

        def make_result():
            results.res = Recorder(runner.stream, runner.descriptions, runner.verbosity)
            return results.res

        runner._makeResult = make_result
        runner.run(suite)
    except CandidateGone as e:
        results.out["error"] = "loading the tests failed: %s" % e
    except BaseException as e:  # noqa: B036 - SystemExit from a test file is still a grading error
        results.out["error"] = "loading the tests failed: %s" % short(sys.exc_info())
        traceback.print_exc(file=sys.stderr)
        if isinstance(e, KeyboardInterrupt):
            raise


def main():
    a = sys.argv[1:]
    opt = lambda k, d=None: a[a.index(k) + 1] if k in a else d  # noqa: E731
    plain = "--plain" in a
    tests = opt("--tests")
    results = Results(opt("--results"))
    source = opt("--source") or opt("--workspace")
    # --budget: seconds this runner may spend; a candidate call still running at the end of it fails
    # (and every later one), so the counts are still written before grade.py's own limit kills us.
    budget = opt("--budget")
    deadline = time.monotonic() + float(budget) if budget else None

    support = types.ModuleType("terrarium_grading")
    support.workspace = source
    support.stdlib = importlib.import_module
    sys.modules["terrarium_grading"] = support
    t0 = time.monotonic()
    if plain:
        # As `python3 -m unittest` in the candidate's directory: it comes first on sys.path.
        sys.path.insert(0, os.getcwd())
        if deadline is not None:
            # Candidate code shares this process, so a hang can't be interrupted: write what finished, then go.
            def expire():
                if results.write({"error": "tests still running at the grading deadline (in %s)" % ((results.res and results.res.current) or "loading"), "seconds": round(time.monotonic() - t0, 2)}):
                    os._exit(0)

            timer = threading.Timer(max(0.0, deadline - time.monotonic()), expire)
            timer.daemon = True
            timer.start()
        run_tests(tests, results)
        results.write({"seconds": round(time.monotonic() - t0, 2)})
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(0)

    op_timeout = opt("--op-timeout")
    timeout = float(op_timeout) if op_timeout else None if budget else 30.0
    client = Client(socket.socket(fileno=int(opt("--fd"))), timeout=timeout, deadline=deadline)
    sys.meta_path.insert(0, CandidateFinder(client, [m for m in (opt("--modules") or "").split(",") if m]))
    run_tests(tests, results)
    results.write({"candidate": client.gone, "seconds": round(time.monotonic() - t0, 2)})


if __name__ == "__main__":
    main()

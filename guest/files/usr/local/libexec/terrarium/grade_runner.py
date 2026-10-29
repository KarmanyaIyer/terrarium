"""Test side of a grading run (uid 1001 in the guest, `python3 -I -S`). Loads the hidden unittest file,
whose imports of the candidate's modules resolve to proxies into the candidate process, runs it, and
writes the counts to --results (a grader-only dir). No candidate code ever runs in this process.

Hidden tests can `import terrarium_grading` for `workspace` (path of the workspace copy, for reading
the candidate's source) and `stdlib(name)` (import a standard-library module locally)."""

import importlib.abc
import importlib.machinery
import importlib.util
import json
import os
import socket
import sys
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

    def addSuccess(self, test):
        super().addSuccess(test)
        self.passed.append(test.id())


def short(err):
    lines = "".join(traceback.format_exception_only(err[0], err[1])).strip().splitlines()
    return (lines[-1] if lines else err[0].__name__)[:300]


def main():
    a = sys.argv[1:]
    opt = lambda k, d=None: a[a.index(k) + 1] if k in a else d  # noqa: E731
    fd = int(opt("--fd"))
    tests = opt("--tests")
    results = opt("--results")
    workspace = opt("--workspace")
    modules = [m for m in (opt("--modules") or "").split(",") if m]
    timeout = float(opt("--op-timeout", "30"))

    client = Client(socket.socket(fileno=fd), timeout=timeout)
    support = types.ModuleType("terrarium_grading")
    support.workspace = workspace
    support.stdlib = importlib.import_module
    sys.modules["terrarium_grading"] = support
    sys.meta_path.insert(0, CandidateFinder(client, modules))

    out = {"expected": 0, "passed": 0, "failures": [], "error": None}
    t0 = time.monotonic()
    try:
        spec = importlib.util.spec_from_file_location("test_hidden", tests)
        mod = importlib.util.module_from_spec(spec)
        sys.modules["test_hidden"] = mod
        spec.loader.exec_module(mod)
        suite = unittest.defaultTestLoader.loadTestsFromModule(mod)
        out["expected"] = suite.countTestCases()
        runner = unittest.TextTestRunner(stream=sys.stderr, verbosity=2, resultclass=Recorder)
        res = runner.run(suite)
        out["passed"] = len(res.passed)
        for kind, items in (("fail", res.failures), ("error", res.errors)):
            for test, tb in items:
                last = [ln for ln in tb.strip().splitlines() if ln.strip()]
                out["failures"].append({"test": test.id().rsplit(".", 1)[-1], "kind": kind, "message": (last[-1] if last else kind)[:300]})
        for test, why in res.skipped:
            out["failures"].append({"test": test.id().rsplit(".", 1)[-1], "kind": "skipped", "message": str(why)[:300]})
    except CandidateGone as e:
        out["error"] = "loading the tests failed: %s" % e
    except BaseException as e:  # noqa: B036 - SystemExit from a test file is still a grading error
        out["error"] = "loading the tests failed: %s" % short(sys.exc_info())
        traceback.print_exc(file=sys.stderr)
        if isinstance(e, KeyboardInterrupt):
            raise
    out["candidate"] = client.gone
    out["seconds"] = round(time.monotonic() - t0, 2)
    fd_out = os.open(results, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd_out, "w") as f:
        json.dump(out, f)


if __name__ == "__main__":
    main()

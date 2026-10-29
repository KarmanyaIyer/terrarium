"""Test side of a grading run. Loads the hidden unittest file, runs it, and writes the counts to --results.

Isolated (default; uid 1001 in the guest, `python3 -B -s -S -P` with the candidate process's hash seed):
imports of the candidate's modules resolve to proxies into the candidate process (--fd); no candidate code
ever runs in this process, and --results is in a grader-only dir. Each test that passes is checked once more
with the candidate process (nothing changed behind the tests' back) before it counts; mock.patch of a module
or standard-library class the candidate process also has is applied there too (grade_rpc.py has the rules).

Plain (--plain; uid 1000 in the guest, after the isolated run has finished): ordinary unittest in one
process, candidate modules imported from the working directory. Exact Python semantics, no protection: the
candidate's code can change these counts, which is why a pass needs both runs.

Hidden tests can `import terrarium_grading` for `workspace` (a copy of the workspace taken before any
candidate code ran, root-owned and read-only in the guest, for reading the candidate's source) and
`stdlib(name)` (import a standard-library module locally)."""

import dis
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
from grade_rpc import GRADER_CODE, RAISED, TEST_ARGV, CandidateGone, Client, Inexact, guard_frames, proxy_rid, std_module, type_path  # noqa: E402

sys.path.remove(HERE)

CLIENT = None
# Module attributes the import system owns on this side; everything else is the candidate module's.
MODULE_LOCAL = frozenset(("__name__", "__spec__", "__loader__", "__path__", "__package__", "__cached__", "__class__", "_terrarium_ref"))
# `from m import *` reading a module's namespace for its names (3.12+: an intrinsic call; before, its own opcode).
STAR = (dis.opmap["CALL_INTRINSIC_1"], 2) if "CALL_INTRINSIC_1" in dis.opmap else (dis.opmap.get("IMPORT_STAR"), None)
_IMPORTING = frozenset(("importlib", "importlib._bootstrap", "importlib._bootstrap_external", "_frozen_importlib", "_frozen_importlib_external", "importlib.util"))
# inspect.getsource and linecache pass a module's namespace to linecache for its __loader__: they get the stand-in
# module's own (the source is read from the tests' copy of the file, as the candidate's loader would have read it).
_SOURCE_READERS = frozenset(("inspect", "linecache"))


class CandidateNamespace(dict):
    """What mock.patch reads as a candidate module's __dict__ (`target.__dict__[name]`): the candidate's value."""

    def __init__(self, ref):
        dict.__init__(self)
        self.ref = ref

    def __missing__(self, name):
        try:
            return getattr(self.ref, name)
        except AttributeError:
            raise KeyError(name) from None


def module_namespace(mod, ref, f):
    """A candidate module's __dict__ for the code in frame f: its names for `from m import *`, its values for
    mock.patch; the stand-in's own for the import system and source readers; for anything else (vars(m), doctest)
    a grader error, as its namespace is in the other process."""
    co = f.f_code.co_code
    if 0 <= f.f_lasti < len(co) - 1 and co[f.f_lasti] == STAR[0] and STAR[1] in (None, co[f.f_lasti + 1]):
        names = CLIENT.call("names", [ref])
        if not (isinstance(names, list) and all(type(n) is str for n in names)):
            raise Inexact("the candidate module's names can't be read")
        return dict.fromkeys(names)
    who = f.f_globals.get("__name__")
    if who == "unittest.mock":
        return CandidateNamespace(ref)
    if who in _IMPORTING or who in _SOURCE_READERS:
        return types.ModuleType.__getattribute__(mod, "__dict__")
    raise Inexact("code read the namespace of candidate module %s (vars(), __dict__): it is in the candidate's process" % types.ModuleType.__getattribute__(mod, "__name__"))


class ProxyModule(types.ModuleType):
    """A candidate module: attribute reads, writes and deletes (mock.patch) go to the candidate's module."""

    def __getattribute__(self, name):
        ref = None if name in MODULE_LOCAL else types.ModuleType.__getattribute__(self, "__dict__").get("_terrarium_ref")
        if ref is None:
            return types.ModuleType.__getattribute__(self, name)
        if name == "__dict__":
            return module_namespace(self, ref, sys._getframe(1))
        return getattr(ref, name)

    def __setattr__(self, name, value):
        ref = None if name in MODULE_LOCAL else types.ModuleType.__getattribute__(self, "__dict__").get("_terrarium_ref")
        if ref is None:
            return types.ModuleType.__setattr__(self, name, value)
        setattr(ref, name, value)

    def __delattr__(self, name):
        ref = None if name in MODULE_LOCAL else types.ModuleType.__getattribute__(self, "__dict__").get("_terrarium_ref")
        if ref is None:
            return types.ModuleType.__delattr__(self, name)
        delattr(ref, name)

    def __dir__(self):
        ref = types.ModuleType.__getattribute__(self, "__dict__").get("_terrarium_ref")
        return dir(ref) if ref is not None else types.ModuleType.__dir__(self)

    def __repr__(self):
        return "<module %r (candidate)>" % types.ModuleType.__getattribute__(self, "__name__")


# As type(m) shows a module: only `type(m) is types.ModuleType` tells them apart (MODULE_TYPE_CHECK).
ProxyModule.__name__ = ProxyModule.__qualname__ = "module"
ProxyModule.__module__ = "builtins"
# A line of the tests comparing a type() with types.ModuleType: a candidate module's stand-in isn't one.
MODULE_TYPE_CHECK = re.compile(r"^(?=.*\btype\().*\bModuleType\b", re.M)


class CandidateLoader(importlib.abc.Loader):
    def __init__(self, client):
        self.client = client

    def create_module(self, spec):
        return ProxyModule(spec.name)

    def exec_module(self, module):
        if self.client.module_inexact is not None:
            raise Inexact(self.client.module_inexact)
        if "_terrarium_ref" in types.ModuleType.__getattribute__(module, "__dict__"):
            # importlib.reload(): the candidate's process runs the module again.
            self.client.call("import", name=module.__name__, reload=True)
            return
        ref = self.client.module(module.__name__)
        if proxy_rid(ref) is None:
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
        if CLIENT is not None:
            # Candidate threads may have changed what the test saw, or failed the grading, after their call.
            try:
                CLIENT.status()
            except BaseException:  # noqa: B036 - a grading failure is the test's error
                self.addError(test, sys.exc_info())
                return
        super().addSuccess(test)
        self.passed.append(test.id())


def short(err):
    lines = "".join(traceback.format_exception_only(err[0], err[1])).strip().splitlines()
    return (lines[-1] if lines else err[0].__name__)[:300]


EXC_LINE = re.compile(r"^[A-Za-z_][\w.]*(Error|Exception|Exit|Interrupt|Warning|CandidateGone|Unsendable|Inexact)\b")


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


# The test process's own state that mock.patch can't reach in the candidate process through this hook: the
# streams, argv and print/input are mirrored on every call instead (grade_rpc.Client._state).
MIRRORED = {"sys": ("stdout", "stderr", "stdin", "argv"), "builtins": ("print", "input")}


# What a candidate function's stand-in here (a real function) can't answer as the candidate's function would.
FN_INTROSPECTION = re.compile(r"__closure__|__globals__|cell_contents|getclosurevars|func_closure|func_globals")
# ... and a candidate generator's (a real generator, which never delegates with `yield from`).
GEN_INTROSPECTION = re.compile(r"gi_yieldfrom")


def refuse_log_asserts():
    """assertLogs and assertNoLogs watch this process's loggers, and candidate code logs in its own process
    (not mirrored here): what they'd answer isn't what one process would, so they are a grader error."""
    try:
        from unittest._log import _AssertLogsContext as ctx
    except ImportError:
        ctx = getattr(unittest.case, "_AssertLogsContext", None)
    if ctx is None:
        return

    def refuse(self):
        raise Inexact("assertLogs/assertNoLogs: logging in the candidate's process isn't mirrored to the tests")

    ctx.__enter__ = refuse


def mirror_patches(client):
    """mock.patch of a standard-library module or class the candidate process also has: patch it there too, as
    one process would see it, and undo it when the patch ends."""
    from unittest import mock

    patch = mock._patch
    enter, exit_ = patch.__enter__, patch.__exit__

    def where(p):
        t = getattr(p, "target", None)
        if isinstance(t, ProxyModule) or proxy_rid(t) is not None:
            return None  # a candidate object: the patch already went to the candidate process
        if isinstance(t, types.ModuleType) and std_module(t.__name__):
            if p.attribute in MIRRORED.get(t.__name__, ()):
                return None
            return t.__name__ + ":"
        if isinstance(t, type) and std_module(t.__module__):
            return type_path(t)
        return None

    def patched_enter(self):
        result = enter(self)
        path = where(self)
        if path is not None:
            try:
                client.call("patch", [getattr(self.target, self.attribute)], name=path, attr=self.attribute)
            except BaseException:
                exit_(self, None, None, None)
                raise
            self._terrarium_patched = path
        return result

    def patched_exit(self, *exc):
        path = self.__dict__.pop("_terrarium_patched", None)
        try:
            return exit_(self, *exc)
        finally:
            if path is not None:
                client.call("unpatch", [], name=path, attr=self.attribute)

    patch.__enter__, patch.__exit__ = patched_enter, patched_exit


def run_tests(tests, results):
    """Load and run the hidden tests, recording into results."""
    try:
        spec = importlib.util.spec_from_file_location("test_hidden", tests)
        mod = importlib.util.module_from_spec(spec)
        sys.modules["test_hidden"] = mod
        spec.loader.exec_module(mod)
        suite = unittest.defaultTestLoader.loadTestsFromModule(mod)
        results.out["expected"] = suite.countTestCases()
        # warnings="default" as unittest.main() (python -m unittest) sets when there are no -W options.
        runner = unittest.TextTestRunner(stream=sys.stderr, verbosity=2, resultclass=Recorder, warnings=None if sys.warnoptions else "default")

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

    # As `python3 -m unittest test_hidden` has it, in both runs (the isolated run's candidate side too).
    sys.argv = list(TEST_ARGV)
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
    global CLIENT
    client = CLIENT = Client(socket.socket(fileno=int(opt("--fd"))), timeout=timeout, deadline=deadline)
    sys.meta_path.insert(0, CandidateFinder(client, [m for m in (opt("--modules") or "").split(",") if m]))
    refuse_log_asserts()
    client.install_guards()
    with open(tests, encoding="utf-8", errors="replace") as f:
        source = f.read()
    if FN_INTROSPECTION.search(source):
        client.fn_inexact = "the tests read functions' closures or globals: a candidate function stands in this process as a real function whose closure and globals are the grader's"
    if GEN_INTROSPECTION.search(source):
        client.gen_inexact = "the tests read gi_yieldfrom: a candidate generator stands in this process as a generator that doesn't delegate"
    if MODULE_TYPE_CHECK.search(source):
        client.module_inexact = "the tests compare a type() with types.ModuleType: a candidate module stands in this process as a module subclass"
    if client.watch is None:
        # Without CPython's watchers (before 3.12) only mock.patch reaches the candidate's process.
        mirror_patches(client)
    # Test code reading the grader's frames (a traceback through candidate code, a stack in a callback) can't see
    # what one process would show: a grader error. The runner and unittest's own reporting may read them.
    guard_frames(GRADER_CODE | {id(globals())}, GRADER_CODE, Inexact, True)
    run_tests(tests, results)
    # A grading error the tests' code caught (a bare except) still counts: grade.py fails a run that made one.
    results.write({"candidate": client.gone, "grader": RAISED[1] if RAISED[0] else None, "seconds": round(time.monotonic() - t0, 2)})


if __name__ == "__main__":
    main()

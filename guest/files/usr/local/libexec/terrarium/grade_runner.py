"""Test side of a grading run. Loads the hidden unittest file, runs it, and writes the counts to --results.

Isolated (default; uid 1001 in the guest, `python3 -B -s -S -P` with the candidate process's hash seed):
imports of the candidate's modules resolve to proxies into the candidate process (--fd); no candidate code
ever runs in this process, and --results is in a grader-only dir. Each test that passes is checked once more
with the candidate process (nothing changed behind the tests' back) before it counts; mock.patch of a module
or standard-library class the candidate process also has is applied there too (grade_rpc.py has the rules).

Plain (--plain; uid 1000 in the guest, after the isolated run has finished): ordinary unittest in one
process, candidate modules imported from the working directory. The accepted report is sent to grade.py's
out-of-process observer. A permanent audit witness protects the runner's private result state and process
completion; explicit snapshots reject changes to unittest, builtins and the reporter. A pass still needs both
runs.

Hidden tests can `import terrarium_grading` for `workspace` (a copy of the workspace taken before any
candidate code ran, root-owned and read-only in the guest, for reading the candidate's source) and
`stdlib(name)` (import a standard-library module locally)."""

import _signal
import builtins
import dis
import importlib.abc
import importlib.machinery
import importlib.util
import io
import json
import os
import posix
import re
import signal
import socket
import sys
import threading
import time
import tokenize
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
# A statement of the tests comparing a type() with types.ModuleType: a candidate module's stand-in isn't one.
MODULE_TYPE_CHECK = re.compile(r"^(?=.*\btype\s*\().*\bModuleType\b", re.M)


def logical_lines(source):
    """source with each statement on one line (tokens space-separated), so a check per line sees all of it."""
    out, cur = [], []
    try:
        for tok in tokenize.generate_tokens(io.StringIO(source).readline):
            if tok.type == tokenize.NEWLINE:
                out.append(" ".join(cur))
                cur = []
            elif tok.type not in (tokenize.NL, tokenize.COMMENT, tokenize.INDENT, tokenize.DEDENT):
                cur.append(tok.string)
    except (tokenize.TokenError, SyntaxError):
        return source
    out.append(" ".join(cur))
    return "\n".join(out)


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
    def __init__(self, *a, integrity=None, **kw):
        super().__init__(*a, **kw)
        self.passed = []
        self.current = None
        self.integrity = integrity or (lambda: None)

    def startTest(self, test):
        self.current = test.id().rsplit(".", 1)[-1]
        super().startTest(test)

    def addSuccess(self, test):
        changed = self.integrity()
        if changed:
            self.addError(test, (RuntimeError, RuntimeError(changed), None))
            return
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
    """Counts so far. Isolated mode writes them once to the grader-only result file."""

    def __init__(self, path=None):
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


def plain_integrity():
    """Return an integrity check whose state candidate code cannot reach through normal Python reflection.

    The audit hook is permanent and keeps the snapshots in its closure. It rejects the reflection primitives
    that would expose this runner's frames/result object, native-library loading, and process exit. Attribute
    assignment has no audit event, so complete class dictionaries and the runner's selected module bindings are
    compared explicitly before execution, after each successful test and after the suite.
    """
    violation = [None]
    protected_function_ids = set()
    trusted_globals = {id(globals())}
    candidate_globals = set()
    audit_busy = set()
    getframe = sys._getframe
    get_ident = threading.get_ident
    denied = frozenset(
        (
            "ctypes.dlopen",
            "ctypes.dlsym",
            "ctypes.dlsym/handle",
            "gc.get_objects",
            "gc.get_referrers",
            "os.exec",
            "sys._current_frames",
            "sys.setprofile",
            "sys.settrace",
        )
    )

    def reject(what):
        if violation[0] is None:
            violation[0] = "candidate code used %s while the plain result was protected" % what
        raise RuntimeError(violation[0])

    trusted_prefix = os.path.realpath(sys.base_prefix) + os.sep
    candidate_prefix = os.path.realpath(os.getcwd()) + os.sep
    frame_reads = frozenset(("tb_frame", "f_code", "gi_frame", "gi_code", "cr_frame", "cr_code", "ag_frame", "ag_code"))

    def audit(event, args):
        if event == "terrarium.plain_violation":
            reject(str(args[0]) if args else "a protected operation")
        if event in denied:
            reject(event)
        if event == "sys._getframe":
            if get_ident() in audit_busy:
                return
            frame = args[0] if args else None
            filename = getattr(getattr(frame, "f_code", None), "co_filename", "")
            if not os.path.realpath(filename).startswith(trusted_prefix):
                reject(event)
        if event == "object.__getattr__" and len(args) > 1 and args[1] in frame_reads:
            tid = get_ident()
            if tid in audit_busy:
                return
            audit_busy.add(tid)
            try:
                obj, name = args[0], args[1]
                frame = obj if name == "f_code" else getattr(obj, "tb_frame" if name == "tb_frame" else name[:3] + "frame", None)
                if not isinstance(frame, types.FrameType):
                    return
                target_mod = frame.f_globals.get("__name__", "")
                protected = id(frame.f_globals) in trusted_globals or target_mod == "unittest" or (isinstance(target_mod, str) and target_mod.startswith("unittest."))
                if not protected:
                    return
                caller = getframe(1)
                while caller is not None:
                    filename = os.path.realpath(caller.f_code.co_filename)
                    if id(caller.f_globals) in candidate_globals or (not filename.startswith(trusted_prefix) and id(caller.f_globals) not in trusted_globals):
                        reject("access to a protected traceback or frame")
                    caller = caller.f_back
            finally:
                audit_busy.discard(tid)
        if event == "import" and args and args[0] in ("_cffi_backend", "_ctypes", "_testcapi", "_testinternalcapi", "cffi", "ctypes"):
            reject("native-memory module %s" % args[0])
        if event == "object.__setattr__" and len(args) > 1 and args[1] in ("__code__", "__defaults__", "__kwdefaults__"):
            if id(args[0]) in protected_function_ids:
                reject("assignment to protected function %s" % args[1])
        if event == "open" and args and isinstance(args[0], str):
            p = os.path.realpath(args[0])
            if p.startswith("/proc/self/fd/") or p == "/proc/self/mem" or p.startswith("/dev/fd/"):
                reject("open(%s)" % args[0])
        if event == "import" and len(args) > 1 and isinstance(args[1], str):
            p = os.path.realpath(args[1])
            if p.endswith((".so", ".dylib")) and not p.startswith(trusted_prefix):
                reject("a native extension outside the Python installation")

    # Candidate signal handlers must keep ordinary alarm/exception behavior, but the interpreter normally hands
    # them the interrupted runner frame. Install one dispatcher before candidate code, remove the raw registration
    # functions, and pass None instead. The raw C functions are not retained by any returned closure.
    real_signal = _signal.signal
    real_getsignal = _signal.getsignal
    virtual_handlers = {}
    guarded_signals = set()
    uncatchable = {int(s) for s in (signal.SIGKILL, signal.SIGSTOP)}
    for name in ("SIGABRT", "SIGBUS", "SIGFPE", "SIGILL", "SIGSEGV", "SIGSYS", "SIGTRAP"):
        if hasattr(signal, name):
            uncatchable.add(int(getattr(signal, name)))
    default_ignored = set()
    for name in ("SIGCHLD", "SIGCONT", "SIGIO", "SIGPOLL", "SIGURG", "SIGWINCH"):
        if hasattr(signal, name):
            default_ignored.add(int(getattr(signal, name)))

    def dispatch_signal(signum, frame):
        handler = virtual_handlers.get(int(signum), signal.SIG_DFL)
        if handler == signal.SIG_IGN or (handler == signal.SIG_DFL and int(signum) in default_ignored):
            return None
        if handler == signal.SIG_DFL:
            raise RuntimeError("signal %d used its default terminating action while the plain result was protected" % signum)
        return handler(signum, None)

    for signum in signal.valid_signals():
        n = int(signum)
        try:
            virtual_handlers[n] = real_getsignal(n)
            if n not in uncatchable:
                real_signal(n, dispatch_signal)
                guarded_signals.add(n)
        except (OSError, RuntimeError, ValueError):
            pass

    def guarded_signal(signum, handler):
        n = int(signum)
        if n not in guarded_signals:
            reject("registration of unsafe signal %d" % n)
        if handler not in (signal.SIG_DFL, signal.SIG_IGN) and not callable(handler):
            raise TypeError("signal handler must be signal.SIG_IGN, signal.SIG_DFL, or a callable object")
        old = virtual_handlers[n]
        virtual_handlers[n] = handler
        return old

    def guarded_getsignal(signum):
        return virtual_handlers.get(int(signum), signal.SIG_DFL)

    _signal.signal = guarded_signal
    _signal.getsignal = guarded_getsignal
    protected_function_ids.update((id(dispatch_signal), id(guarded_signal), id(guarded_getsignal)))

    sys.addaudithook(audit)

    # No original _exit reference remains in Python after these assignments. A SystemExit is caught by
    # run_tests; signals/crashes give grade.py a nonzero child status. The real report is appended only after
    # the suite returns, so bytes forged on its socket make the JSON invalid instead of replacing the result.
    def no_exit(status):
        sys.audit("terrarium.plain_violation", "os._exit(%r)" % status)
        raise RuntimeError("os._exit is disabled while the plain result is protected")

    os._exit = no_exit
    posix._exit = no_exit

    owners = (
        unittest.TestCase,
        unittest.FunctionTestCase,
        unittest.BaseTestSuite,
        unittest.TestSuite,
        unittest.TestLoader,
        unittest.TestResult,
        unittest.TextTestResult,
        unittest.TextTestRunner,
        json.JSONEncoder,
        Recorder,
        Results,
    )
    classes = tuple((owner, dict(vars(owner))) for owner in owners)
    module_attrs = tuple(
        (unittest, name, getattr(unittest, name))
        for name in (
            "BaseTestSuite",
            "FunctionTestCase",
            "TestCase",
            "TestLoader",
            "TestResult",
            "TestSuite",
            "TextTestResult",
            "TextTestRunner",
            "defaultTestLoader",
            "main",
        )
    )
    json_attrs = dict(vars(json))
    builtin_attrs = dict(vars(builtins))
    signal_attrs = dict(vars(signal))
    raw_signal_attrs = dict(vars(_signal))
    codes = []
    for owner, attrs in classes:
        for name, value in attrs.items():
            if isinstance(value, (classmethod, staticmethod)):
                value = value.__func__
            code = getattr(value, "__code__", None)
            if code is not None:
                codes.append((owner, name, value, code))
                protected_function_ids.add(id(value))
    for module in (sys.modules[__name__], unittest, json):
        for value in vars(module).values():
            if isinstance(value, types.FunctionType):
                protected_function_ids.add(id(value))
    protected_function_ids.add(id(no_exit))
    no_exit_code = no_exit.__code__

    def check():
        if violation[0] is not None:
            return violation[0]
        if os._exit is not no_exit or posix._exit is not no_exit or no_exit.__code__ is not no_exit_code:
            return "candidate code replaced the protected process-exit guard"
        now_builtins = vars(builtins)
        if now_builtins.keys() != builtin_attrs.keys():
            return "candidate code changed builtins"
        for name, value in builtin_attrs.items():
            if now_builtins.get(name) is not value:
                return "candidate code replaced builtins.%s" % name
        for owner, before in classes:
            now = vars(owner)
            if now.keys() != before.keys():
                return "candidate code changed %s attributes" % owner.__name__
            for name, value in before.items():
                if now.get(name) is not value:
                    return "candidate code replaced unittest.%s.%s" % (owner.__name__, name)
        for module, name, value in module_attrs:
            if getattr(module, name, None) is not value:
                return "candidate code replaced unittest.%s" % name
        now_json = vars(json)
        if now_json.keys() != json_attrs.keys():
            return "candidate code changed the JSON reporter module"
        for name, value in json_attrs.items():
            if now_json.get(name) is not value:
                return "candidate code replaced json.%s used by the reporter" % name
        for module, before in ((signal, signal_attrs), (_signal, raw_signal_attrs)):
            now = vars(module)
            if now.keys() != before.keys():
                return "candidate code changed the protected signal module"
            for name, value in before.items():
                if now.get(name) is not value:
                    return "candidate code replaced protected signal.%s" % name
        for owner, name, value, code in codes:
            if getattr(value, "__code__", None) is not code:
                return "candidate code changed the code of unittest.%s.%s" % (owner.__name__, name)
        return None

    def trust(mod):
        trusted_globals.add(id(vars(mod)))
        for loaded in tuple(sys.modules.values()):
            namespace = getattr(loaded, "__dict__", None)
            filename = namespace.get("__file__") if isinstance(namespace, dict) else None
            if isinstance(filename, str) and os.path.realpath(filename).startswith(candidate_prefix):
                candidate_globals.add(id(namespace))

    protected_function_ids.update((id(check), id(trust)))
    return check, trust


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


def run_tests(tests, results, integrity=lambda: None, trust=lambda mod: None):
    """Load and run the hidden tests, recording into results."""
    try:
        spec = importlib.util.spec_from_file_location("test_hidden", tests)
        mod = importlib.util.module_from_spec(spec)
        sys.modules["test_hidden"] = mod
        spec.loader.exec_module(mod)
        trust(mod)
        suite = unittest.defaultTestLoader.loadTestsFromModule(mod)
        results.out["expected"] = suite.countTestCases()
        changed = integrity()
        if changed:
            results.out["error"] = changed
            return
        # warnings="default" as unittest.main() (python -m unittest) sets when there are no -W options.
        runner = unittest.TextTestRunner(stream=sys.stderr, verbosity=2, resultclass=Recorder, warnings=None if sys.warnoptions else "default")

        def make_result():
            results.res = Recorder(runner.stream, runner.descriptions, runner.verbosity, integrity=integrity)
            return results.res

        runner._makeResult = make_result
        runner.run(suite)
        changed = integrity()
        if changed and not results.out["error"]:
            results.out["error"] = changed
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
    report_fd = opt("--report-fd")
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
        # Keep all accepted state in locals hidden behind the permanent audit hook. grade.py owns the other
        # end of the socket and rejects a nonzero/early exit, malformed JSON, a hang or an integrity error.
        integrity, trust = plain_integrity()
        write_fd, close_fd = os.write, os.close
        encode = json.JSONEncoder(separators=(",", ":")).encode
        encode_code = encode.__func__.__code__
        fd = int(report_fd)
        run_tests(tests, results, integrity, trust)
        changed = integrity()
        if encode.__func__.__code__ is not encode_code or (changed and any(word in changed for word in ("builtins", "JSON", "json.", "Recorder", "Results"))):
            raise RuntimeError(changed or "candidate code changed the protected JSON encoder")
        if changed and not results.out["error"]:
            results.out["error"] = changed
        # Inline collection keeps the accepted state in this frame. Reflection APIs that could expose it are
        # rejected by the audit hook; candidate code never receives this Results wrapper.
        out = dict(results.out, failures=list(results.out["failures"]))
        res = results.res
        if res is not None:
            out["passed"] = len(res.passed)
            out["failures"] = []
            for kind, items in (("fail", res.failures), ("error", res.errors)):
                for test, tb in items:
                    out["failures"].append({"test": test.id().rsplit(".", 1)[-1], "kind": kind, "message": summary(tb, kind)})
            for test, why in res.skipped:
                out["failures"].append({"test": test.id().rsplit(".", 1)[-1], "kind": "skipped", "message": str(why)[:300]})
        out["seconds"] = round(time.monotonic() - t0, 2)
        data = encode(out).encode("utf-8")
        while data:
            n = write_fd(fd, data)
            if n <= 0:
                raise OSError("plain result observer closed")
            data = data[n:]
        close_fd(fd)
        sys.stdout.flush()
        sys.stderr.flush()
        return

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
    if MODULE_TYPE_CHECK.search(source) or MODULE_TYPE_CHECK.search(logical_lines(source)):
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

"""Review 5 cases: each case (m.py + tests.py, plus workspace files) under grade.py --local and under plain
`python3 -m unittest`, side by side. The isolated run's own verdict is what counts (the plain run beside it can be
forged): "pass", "fail" (a test failed or raised an ordinary exception) or "inexact" (a grader error).

EXPECT: case -> (plain unittest passes?, the isolated run's verdict). A case where plain unittest fails must never
get an isolated "pass"; one where it passes gets "pass", or "inexact" where the grader can't reproduce Python.
usage: run.py [case ...] (default: all). PY=<python> picks the interpreter (default: this one)."""
import json, os, re, shutil, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
GRADE = os.environ.get("GRADE") or os.path.join(HERE, "../../guest/files/usr/local/libexec/terrarium/grade.py")
PY = os.environ.get("PY") or sys.executable
EXPECT = {
    # 1: state candidate code changes reaches the tests
    "env_leak": (False, "fail"),
    "env_ok": (True, "pass"),
    "cwd_leak": (False, "fail"),
    "cwd_ok": (True, "pass"),
    "argv_leak": (False, "fail"),
    "argv_ok": (True, "pass"),
    "stdout_leak": (False, "fail"),
    "stdout_swap": (True, "pass"),
    "print_swap": (False, "fail"),
    "print_hook": (True, "pass"),
    "syspath_leak": (False, "inexact"),
    "syspath_tests": (True, "pass"),
    "syspath_order": (True, "pass"),
    "umask_ok": (True, "pass"),
    "tz_ok": (True, "pass"),
    "locale_ok": (True, "pass"),
    # 2: context managers with an exception in the with body; test handles where built-in data is needed
    "ctx_cwd": (True, "pass"),
    "ctx_reraise": (False, "fail"),
    "ctx_reraise_ok": (True, "pass"),
    "ctx_tb": (True, "pass"),
    "ctx_tb_names": (True, "inexact"),
    "handle_typeerror": (False, "inexact"),
    # 3: the documented gaps
    "log_handler": (False, "inexact"),
    "slots_weak": (True, "pass"),
    "slots_weak_lenient": (False, "fail"),
    "func_type": (False, "fail"),
    "func_type_ok": (True, "pass"),
    "tb_names": (False, "inexact"),
    "id_cached": (False, "fail"),
    "stdlib_assign": (False, "inexact"),
    "stdlib_assign_tests": (True, "inexact"),
    # 4: refcounts and referrers of candidate objects
    "refcount_leak": (False, "inexact"),
    # 5: identity of values that cross by value
    "tuple_identity": (False, "fail"),
    "tuple_identity_ok": (True, "pass"),
    # 6: namedtuples (3.13+ adds __replace__)
    "ntuple_replace": (True, "pass"),
}
FORGE = (
    "import sys as _s, unittest as _u\n"
    "if 'test_hidden' in _s.modules:\n"
    "    def _run(self, result=None):\n"
    "        result.startTest(self); result.addSuccess(self); result.stopTest(self)\n"
    "        return result\n"
    "    _u.TestCase.run = _run\n"
)
GRADER_ERROR = re.compile(r"\b(Inexact|CandidateGone|Unsendable|GraderError|_Poisoned)\b")


def iso_verdict(j):
    if j.get("expected", 0) > 0 and j.get("passed") == j.get("expected") and not j.get("error"):
        return "pass"
    if j.get("error") or j.get("candidate") or any(GRADER_ERROR.search(f.get("message", "")) for f in j.get("failures", [])):
        return "inexact"
    return "fail"


def grade(case, forged, timeout):
    base = tempfile.mkdtemp(prefix="r5case-")
    try:
        ws = os.path.join(base, "ws")
        shutil.copytree(case, ws, ignore=shutil.ignore_patterns("tests.py"))
        if forged:
            p = os.path.join(ws, "m.py")
            src = open(p).read()
            open(p, "w").write(FORGE + src)
        hidden = os.path.join(base, "test_hidden.py")
        shutil.copy(os.path.join(case, "tests.py"), hidden)
        r = subprocess.run([PY, "-I", "-S", GRADE, "--local", "--tests", hidden, "--workspace", ws, "--timeout", str(timeout)], capture_output=True, text=True, timeout=2 * timeout + 60)
        return json.loads(r.stdout.strip().splitlines()[-1])
    finally:
        shutil.rmtree(base, ignore_errors=True)


def plain(case, timeout):
    base = tempfile.mkdtemp(prefix="r5plain-")
    try:
        ws = os.path.join(base, "ws")
        shutil.copytree(case, ws, ignore=shutil.ignore_patterns("tests.py"))
        shutil.copy(os.path.join(case, "tests.py"), os.path.join(ws, "test_hidden.py"))
        p = subprocess.run([PY, "-m", "unittest", "test_hidden"], cwd=ws, capture_output=True, text=True, timeout=timeout + 60)
        return p.returncode == 0
    finally:
        shutil.rmtree(base, ignore_errors=True)


def run(name, timeout=30):
    case = os.path.join(HERE, name)
    want_plain, want_iso = EXPECT[name]
    t0 = time.monotonic()
    ok = plain(case, timeout)
    h = grade(case, False, timeout)
    iso = iso_verdict(h)
    out = {"case": name, "plain_ok": ok, "iso": iso, "counts": "%s/%s" % (h.get("passed"), h.get("expected")), "verdict": h.get("verdict"), "secs": round(time.monotonic() - t0, 1)}
    msgs = [f.get("message", "")[:140] for f in h.get("failures", [])][:2] + ([h["candidate"][:140]] if h.get("candidate") else [])
    if msgs:
        out["why"] = msgs
    good = ok == want_plain and iso == want_iso
    if not want_plain:
        # A forged plain run (it passes everything) must not turn the case into a pass.
        out["forged"] = grade(case, True, timeout)["verdict"]
        good = good and out["forged"] != "pass"
    return good, out


if __name__ == "__main__":
    from concurrent.futures import ThreadPoolExecutor

    args = sys.argv[1:]
    jobs = 1
    if args[:1] == ["-j"]:
        jobs, args = int(args[1]), args[2:]
    names = args or sorted(EXPECT)
    bad = 0
    with ThreadPoolExecutor(jobs) as pool:
        for good, o in pool.map(run, names):
            bad += not good
            print(("ok  " if good else "BAD ") + json.dumps(o), flush=True)
    print("%d of %d as expected" % (len(names) - bad, len(names)))

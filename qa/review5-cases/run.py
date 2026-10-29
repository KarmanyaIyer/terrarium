"""Review 5 cases: each case (m.py + tests.py, plus workspace files) under grade.py --local and under plain
`python3 -m unittest`, side by side. The isolated run's own verdict is what counts (the plain run beside it can be
forged): "pass", "fail" (a test failed or raised an ordinary exception) or "inexact" (a grader error).

expect.json: case -> (plain unittest passes?, the isolated run's verdict). A case where plain unittest fails must never
get an isolated "pass"; one where it passes gets "pass", or "inexact" where the grader can't reproduce Python.
usage: run.py [case ...] (default: all). PY=<python> picks the interpreter (default: this one)."""
import json, os, re, shutil, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
GRADE = os.environ.get("GRADE") or os.path.join(HERE, "../../guest/files/usr/local/libexec/terrarium/grade.py")
PY = os.environ.get("PY") or sys.executable
# expect.json: item -> {case: [plain unittest passes?, the isolated run's verdict]} (the node and VM tests read it too).
with open(os.path.join(HERE, "expect.json")) as f:
    EXPECT = {k: tuple(v) for g in json.load(f).values() for k, v in g.items()}
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

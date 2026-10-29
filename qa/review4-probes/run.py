"""Review 4 probes: each case (m.py + tests.py) under grade.py --local, honest and with a forged plain run, plus
plain `python3 -m unittest` on the honest code. usage: run.py [case ...] (default: all)

LENIENT cases: plain unittest fails on the honest code, and so must the grade, forged or not (fail or disagree,
never pass). CHEAT cases pass in one process but must not pass the grade. CORRECT cases: plain unittest passes; the grade should pass. PERF cases: plain unittest passes and
the grade should pass quickly."""
import json, os, shutil, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
GRADE = os.environ.get("GRADE") or os.path.join(HERE, "../../guest/files/usr/local/libexec/terrarium/grade.py")
LENIENT = ["ret_list", "ret_nested", "hy_add", "hy_lt", "hy_int", "hy_format", "hy_neg", "exc_args", "exc_str", "test_sub", "stale_hy", "ddict_factory", "ref_ne", "ref_abc", "ref_op", "type_isnot", "stdout_quiet", "nest_stale", "rec_depth", "dec_ctx", "logs_none", "warn_quiet"]
CORRECT = ["hash_seed", "ctx", "mock_patch", "bigint", "exc_attrs", "nested_tuples", "copy_hy", "type_is", "threads", "stdout_capture", "nest_reheld", "warn_ok"]
PERF = ["perf_bsearch", "perf_returns"]
# Cheats that pass in one process too: the isolated run must not pass them.
CHEAT = ["ne_lie"]
# Replaces unittest's TestCase.run in the plain run (where the hidden tests share the candidate's process).
FORGE = (
    "import sys as _s, unittest as _u\n"
    "if 'test_hidden' in _s.modules:\n"
    "    def _run(self, result=None):\n"
    "        result.startTest(self); result.addSuccess(self); result.stopTest(self)\n"
    "        return result\n"
    "    _u.TestCase.run = _run\n"
)
PY = os.environ.get("PY") or sys.executable


def grade(case, forged, timeout):
    base = tempfile.mkdtemp(prefix="r4probe-")
    try:
        ws = os.path.join(base, "ws")
        os.mkdir(ws)
        for n in os.listdir(case):
            if n != "tests.py":
                src = open(os.path.join(case, n)).read()
                open(os.path.join(ws, n), "w").write((FORGE + src) if forged and n == "m.py" else src)
        hidden = os.path.join(base, "test_hidden.py")
        shutil.copy(os.path.join(case, "tests.py"), hidden)
        t0 = time.monotonic()
        r = subprocess.run([PY, "-I", "-S", GRADE, "--local", "--tests", hidden, "--workspace", ws, "--timeout", str(timeout)], capture_output=True, text=True, timeout=2 * timeout + 60)
        j = json.loads(r.stdout.strip().splitlines()[-1])
        j["_secs"] = round(time.monotonic() - t0, 2)
        return j
    finally:
        shutil.rmtree(base, ignore_errors=True)


def plain(case, timeout):
    base = tempfile.mkdtemp(prefix="r4plain-")
    try:
        for n in os.listdir(case):
            shutil.copy(os.path.join(case, n), os.path.join(base, "test_hidden.py" if n == "tests.py" else n))
        p = subprocess.run([PY, "-m", "unittest", "test_hidden"], cwd=base, capture_output=True, text=True, timeout=timeout + 60)
        return p.returncode == 0
    finally:
        shutil.rmtree(base, ignore_errors=True)


def run(name, timeout=30):
    case = os.path.join(HERE, name)
    ok = plain(case, timeout)
    h = grade(case, False, timeout)
    out = {"case": name, "plain_ok": ok, "honest": h["verdict"], "iso": "%s/%s" % (h.get("passed"), h.get("expected")), "secs": h.get("wallSeconds"), "fails": [f.get("message", "")[:120] for f in h.get("failures", [])][:2]}
    if name in LENIENT or name in CHEAT:
        out["forged"] = grade(case, True, timeout)["verdict"]
    return out


if __name__ == "__main__":
    names = sys.argv[1:] or LENIENT + CHEAT + CORRECT + PERF
    bad = 0
    for n in names:
        o = run(n)
        if n in LENIENT or n in CHEAT:
            good = o["plain_ok"] == (n in CHEAT) and o["honest"] != "pass" and o["forged"] != "pass"
        else:
            good = o["plain_ok"] and o["honest"] == "pass"
        bad += not good
        print(("ok  " if good else "BAD ") + json.dumps(o))
    print("%d of %d as expected" % (len(names) - bad, len(names)))

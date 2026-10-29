"""Review 6 cases: each case under grade.py --local beside plain `python3 -m unittest`, as qa/review5-cases/run.py
(whose grade/plain/verdict helpers this reuses).

expect.json: item -> {case: [plain unittest passes?, the isolated run's verdict]}. The verdict is "pass", "fail",
"inexact" (a grader error) or "known-lenient": a documented gap (guest/README.md, known gaps) where plain unittest
fails and the isolated run still passes. Those are reported ("gap"), never counted as bad; one that stops passing
is reported as "fixed?" so its expectation can be tightened.
usage: run.py [-j N] [case ...] (default: all). PY=<python> picks the interpreter (default: this one)."""
import importlib.util, json, os, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("review5_run", os.path.join(HERE, "../review5-cases/run.py"))
r5 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(r5)
with open(os.path.join(HERE, "expect.json")) as f:
    EXPECT = {k: tuple(v) for g in json.load(f).values() for k, v in g.items()}


def run(name, timeout=30):
    case = os.path.join(HERE, name)
    want_plain, want_iso = EXPECT[name]
    t0 = time.monotonic()
    ok = r5.plain(case, timeout)
    h = r5.grade(case, False, timeout)
    iso = r5.iso_verdict(h)
    out = {"case": name, "plain_ok": ok, "iso": iso, "counts": "%s/%s" % (h.get("passed"), h.get("expected")), "verdict": h.get("verdict"), "secs": round(time.monotonic() - t0, 1), "wall": h.get("wallSeconds")}
    msgs = [f.get("message", "")[:140] for f in h.get("failures", [])][:2] + ([h["candidate"][:140]] if h.get("candidate") else [])
    if msgs:
        out["why"] = msgs
    if want_iso == "known-lenient":
        return ("gap" if ok == want_plain and iso == "pass" else "fixed?" if ok == want_plain else "BAD"), out
    good = ok == want_plain and iso == want_iso
    if not want_plain:
        # A forged plain run (it passes everything) must not turn the case into a pass.
        out["forged"] = r5.grade(case, True, timeout)["verdict"]
        good = good and out["forged"] != "pass"
    return ("ok" if good else "BAD"), out


if __name__ == "__main__":
    from concurrent.futures import ThreadPoolExecutor

    args = sys.argv[1:]
    jobs = 1
    if args[:1] == ["-j"]:
        jobs, args = int(args[1]), args[2:]
    names = args or sorted(EXPECT)
    tally = {}
    with ThreadPoolExecutor(jobs) as pool:
        for mark, o in pool.map(run, names):
            tally[mark] = tally.get(mark, 0) + 1
            print("%-6s %s" % (mark, json.dumps(o)), flush=True)
    gaps = tally.get("gap", 0) + tally.get("fixed?", 0)
    print("%d of %d as expected; %d known-lenient (%d still pass, %d fixed?)" % (tally.get("ok", 0), len(names) - gaps, gaps, tally.get("gap", 0), tally.get("fixed?", 0)))
    sys.exit(1 if tally.get("BAD") else 0)

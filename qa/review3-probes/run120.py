"""Run a case under grade.py --local and plain unittest. usage: run.py <casedir> (m.py + tests.py body)"""
import json, os, shutil, subprocess, sys, tempfile
GRADE = "/home/karvi/Projects/g-terrarium-review/guest/files/usr/local/libexec/terrarium/grade.py"
def run(case, timeout=120):
    files = {}
    for n in os.listdir(case):
        if n != "tests.py":
            files[n] = open(os.path.join(case, n)).read()
    body = open(os.path.join(case, "tests.py")).read()
    base = tempfile.mkdtemp(prefix="probe-")
    ws = os.path.join(base, "ws"); os.mkdir(ws)
    for n, c in files.items():
        open(os.path.join(ws, n), "w").write(c)
    hidden = os.path.join(base, "test_hidden.py")
    open(hidden, "w").write(body)
    r = subprocess.run([sys.executable, "-I", "-S", GRADE, "--local", "--tests", hidden, "--workspace", ws, "--timeout", str(timeout)], capture_output=True, text=True, timeout=timeout + 30)
    j = json.loads(r.stdout.strip().splitlines()[-1])
    print("RPC:   pass=%s %s/%s error=%s" % (j.get("pass"), j.get("passed"), j.get("expected"), j.get("error")))
    for f in j.get("failures", []):
        print("   ", f)
    if os.environ.get("SHOWOUT"):
        print(j.get("testOutput")); print(j.get("candidateOutput"))
    # plain unittest, one process
    plain = os.path.join(base, "plain"); shutil.copytree(ws, plain)
    shutil.copy(hidden, os.path.join(plain, "test_hidden.py"))
    os.makedirs(os.path.join(plain, "_tg"), exist_ok=True)
    open(os.path.join(plain, "terrarium_grading.py"), "w").write("import importlib\nworkspace=%r\nstdlib=importlib.import_module\n" % plain)
    p = subprocess.run([sys.executable, "-m", "unittest", "-v", "test_hidden"], cwd=plain, capture_output=True, text=True, timeout=timeout + 30)
    last = [l for l in p.stderr.strip().splitlines() if l.startswith(("OK", "FAILED", "Ran"))]
    print("PLAIN: rc=%s %s" % (p.returncode, " | ".join(last)))
    if os.environ.get("SHOWPLAIN"):
        print(p.stderr[-3000:])
    shutil.rmtree(base, ignore_errors=True)
if __name__ == "__main__":
    for c in sys.argv[1:]:
        print("==", c); run(c)

"""Terrarium test grader (root, `python3 -I -S`). usage:

  grade.py --tests /grader/test_hidden.py [--workspace /workspace] [--timeout 120] [--id <id>]
  grade.py --command <shell command> [--workspace /workspace] [--timeout 170] [--id <id>]
  grade.py --local --tests <file> --workspace <dir>     (host-side reference checks, no uid switching)

--timeout applies to each of the two runs of a tests check.

Tests: every check is graded twice, and passes only if both runs pass.
1. Kills every agent (uid 1000) and grader (uid 1001) process, so nothing the agent left running can touch
   the workspace or the grading.
2. Copies the workspace three times under /var/lib/terrarium-grade/<id>/, all before any candidate code
   runs: `src`, root-owned, read-only and without symlinks, is what the hidden tests read as the candidate's
   source; `ws`, agent-owned, is where the isolated run's candidate code runs; `plain/ws` is the plain run's,
   in a root-only dir until that run starts.
3. Isolated run: the candidate side (grade_worker.py) as agent in `ws` and the test side (grade_runner.py) as
   grader, connected by a socketpair, so the hidden tests never share a process with candidate code. Its
   counts go to a grader-only dir; they are read, and everything it started is killed, before step 4.
4. Plain run: grade_runner.py --plain as agent in `plain/ws`, the hidden tests (copied from /grader) and
   candidate code in one process, as `python3 -m unittest` would run them. Exact Python semantics, no
   protection: candidate code can change these counts, but not the isolated run's, which are already read.
5. Prints one JSON line: the isolated run's counts at the top level, the plain run's under "plain", and a
   verdict: "pass" (both counted at least one test and every test passed), "fail" (neither did) or
   "disagree" (one did): a grader error, never a pass. Exit 0 only on "pass".

Command: kills agent and grader processes, then runs the command with bash as agent (never root, never a
uid that can read /grader) in the workspace, with a clean environment: PATH has only root-owned dirs and
HOME is a fresh empty dir, so nothing the agent planted in its home or ~/.local runs instead. Kills
everything the command started and prints one JSON line; exit 0 only if the command exited 0 in time.
"""

import json
import os
import shutil
import socket
import stat
import subprocess
import sys
import sysconfig
import tempfile
import threading
import time

LIBEXEC = os.path.dirname(os.path.abspath(__file__))
RUN = os.path.join(LIBEXEC, "run")
KILL = os.path.join(LIBEXEC, "kill")
KILL_USER = os.path.join(LIBEXEC, "kill-user")
WORKER = os.path.join(LIBEXEC, "grade_worker.py")
RUNNER = os.path.join(LIBEXEC, "grade_runner.py")
BASE = "/var/lib/terrarium-grade"
AGENT_UID = 1000
GRADER_UID = 1001
TAIL = 6000

AGENT_ENV = {
    "HOME": "/home/agent",
    "USER": "agent",
    "LOGNAME": "agent",
    "PATH": "/home/agent/.local/bin:/usr/local/bin:/usr/bin:/bin",
    "LANG": "C.UTF-8",
    "PYTHONDONTWRITEBYTECODE": "1",
    "PYTHONUNBUFFERED": "1",
}
GRADER_ENV = {"HOME": "/nonexistent", "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}
CHECK_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"


class Tail:
    """Reads a pipe in the background, keeping the last TAIL bytes."""

    def __init__(self, stream):
        self.buf = b""
        self.total = 0
        self.t = threading.Thread(target=self._pump, args=(stream,), daemon=True)
        self.t.start()

    def _pump(self, stream):
        while True:
            chunk = stream.read(65536)
            if not chunk:
                return
            self.total += len(chunk)
            self.buf = (self.buf + chunk)[-TAIL:]

    def text(self):
        self.t.join(timeout=2)
        s = self.buf.decode("utf-8", "replace")
        return ("[...]" + s) if self.total > len(self.buf) else s


def stdlib_names():
    names = set(getattr(sys, "stdlib_module_names", ())) | set(sys.builtin_module_names)
    if names - set(sys.builtin_module_names):
        return names
    paths = sysconfig.get_paths()
    for d in {paths.get("stdlib"), paths.get("platstdlib")}:
        if not d or not os.path.isdir(d):
            continue
        for n in os.listdir(d):
            if n.endswith(".py"):
                names.add(n[:-3])
            elif os.path.isfile(os.path.join(d, n, "__init__.py")):
                names.add(n)
        dyn = os.path.join(d, "lib-dynload")
        if os.path.isdir(dyn):
            names.update(n.split(".")[0] for n in os.listdir(dyn))
    return names


def candidate_modules(ws):
    """Top-level modules in the workspace the hidden tests may import, minus standard-library names."""
    std = stdlib_names() | {"terrarium_grading", "test_hidden", "grade_rpc"}
    out = []
    for n in sorted(os.listdir(ws)):
        p = os.path.join(ws, n)
        name = n[:-3] if n.endswith(".py") and os.path.isfile(p) else n if os.path.isdir(p) and not os.path.islink(p) else None
        if name and name.isidentifier() and name not in std:
            out.append(name)
    return out


def read_results(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError as e:
        return None, "no results file (%s)" % e.strerror
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size > (1 << 20):
            return None, "results file is not a small regular file"
        data = os.read(fd, st.st_size + 1)
    finally:
        os.close(fd)
    try:
        r = json.loads(data.decode("utf-8"))
    except ValueError as e:
        return None, "unreadable results file (%s)" % e
    if not isinstance(r, dict) or type(r.get("expected")) is not int or type(r.get("passed")) is not int:
        return None, "results file has no counts"
    return r, None


def seal(root, local=False):
    """The hidden tests' copy of the sources: nothing in it stays writable by the agent, and nothing in it
    leads elsewhere. Symlinks are removed, never followed: as root a link could read any file, and a link into
    the live workspace would let candidate code change what the tests read. The agent's files become
    root-owned and world-readable; anything else (a hard link the agent made to another user's file) keeps
    its owner and mode, so nothing becomes readable that wasn't. Set-id bits are dropped. local: only the
    symlinks go."""
    for d, dirs, files in os.walk(root):
        for n in list(dirs) + files:
            p = os.path.join(d, n)
            st = os.lstat(p)
            if stat.S_ISLNK(st.st_mode):
                os.remove(p)
                if n in dirs:
                    dirs.remove(n)
                continue
            if local:
                continue
            mine = st.st_uid == AGENT_UID
            mode = stat.S_IMODE(st.st_mode) & 0o755
            if mine:
                os.lchown(p, 0, 0)
                mode |= 0o555 if stat.S_ISDIR(st.st_mode) else 0o444
            os.chmod(p, mode)
    if not local:
        os.chown(root, 0, 0)
        os.chmod(root, 0o755)


def copy_tests(tests, dst):
    """The hidden tests for the plain run (agent): all of /grader (or the tests file's dir) copied root-owned
    and world-readable, so files next to the tests resolve as in the isolated run. Returns the tests file's
    path in the copy."""
    root = "/grader" if tests.startswith("/grader/") else os.path.dirname(tests)
    os.mkdir(dst, 0o700)
    copy_workspace(root, dst)
    for d, dirs, files in os.walk(dst):
        for n in list(dirs) + files:
            p = os.path.join(d, n)
            st = os.lstat(p)
            if stat.S_ISLNK(st.st_mode):
                os.remove(p)
                if n in dirs:
                    dirs.remove(n)
                continue
            os.lchown(p, 0, 0)
            os.chmod(p, 0o755 if stat.S_ISDIR(st.st_mode) else 0o644)
    os.chmod(dst, 0o755)
    return os.path.join(dst, os.path.relpath(tests, root))


def copy_workspace(src, dst):
    """cp -a as root: keeps owners, modes and symlinks (never followed)."""
    cp = subprocess.run(["/bin/cp", "-a", "--", src + "/.", dst + "/"], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=120)
    if cp.returncode != 0:
        raise RuntimeError("copying the workspace failed: %s" % cp.stderr.decode("utf-8", "replace").strip()[:300])


def kill_users(local=False):
    if not local:
        for who in ("agent", "grader"):
            try:
                subprocess.run([KILL_USER, who], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
            except (OSError, subprocess.SubprocessError):
                pass


def job_dir(gid):
    os.makedirs(BASE, mode=0o711, exist_ok=True)
    os.chmod(BASE, 0o711)
    job = os.path.join(BASE, gid)
    if os.path.lexists(job):
        shutil.rmtree(job)
    os.mkdir(job, 0o711)
    return job


def run_command(command, workspace, timeout, gid):
    """A `command` check: bash as agent in the workspace with a clean environment; pass on exit 0."""
    out = {"exitCode": None, "timedOut": False, "output": "", "error": None}
    kill_users()
    job = job_dir(gid)
    try:
        home = os.path.join(job, "home")
        os.mkdir(home, 0o700)
        os.chown(home, AGENT_UID, AGENT_UID)
        env = {"HOME": home, "USER": "agent", "LOGNAME": "agent", "PATH": CHECK_PATH, "LANG": "C.UTF-8", "TERM": "dumb", "PYTHONDONTWRITEBYTECODE": "1"}
        cid = gid + "-c"
        p = subprocess.Popen([RUN, cid, "agent", workspace, "/bin/bash", "-c", command], env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        tail = Tail(p.stdout)
        try:
            out["exitCode"] = p.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            out["timedOut"] = True
        subprocess.run([KILL, cid], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
        try:
            p.wait(timeout=10)
        except subprocess.TimeoutExpired:
            p.kill()
        kill_users()
        out["output"] = tail.text()
    except Exception as e:
        out["error"] = "%s: %s" % (type(e).__name__, e)
    finally:
        kill_users()
        shutil.rmtree(job, ignore_errors=True)
    out["pass"] = out["error"] is None and not out["timedOut"] and out["exitCode"] == 0
    print(json.dumps(out))
    return 0 if out["pass"] else 1


MAX_FAILURES = 50


def blank(error=None):
    return {"passed": 0, "expected": 0, "failures": [], "timedOut": False, "error": error}


def ok(r):
    return not r["error"] and r["expected"] > 0 and r["passed"] == r["expected"]


def wait(p, timeout):
    """Whether p was still running after timeout seconds."""
    try:
        p.wait(timeout=max(1.0, timeout))
        return False
    except subprocess.TimeoutExpired:
        return True


def stop(procs, local):
    """Kill each (process, exec id) with everything it started."""
    for p, xid in procs:
        if local:
            try:
                os.killpg(p.pid, 9)
            except OSError:
                pass
        else:
            subprocess.run([KILL, xid], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
        try:
            p.wait(timeout=10)
        except subprocess.TimeoutExpired:
            p.kill()
    kill_users(local)


def outcome(runner, results, timed_out, timeout):
    """A run's counts, from its runner's results file."""
    r = blank()
    r["timedOut"] = timed_out
    if timed_out:
        r["error"] = "timed out after %gs" % timeout
        return r
    data, err = read_results(results)
    if err:
        r["error"] = "%s; test runner exited %s" % (err, runner.returncode)
    elif runner.returncode != 0:
        # The runner exits 0 right after writing its results, so a results file next to a failed runner is
        # not its own (in --local mode the candidate runs as the same user).
        r["error"] = "test runner exited %s; results file ignored" % runner.returncode
    else:
        r["passed"] = data["passed"]
        r["expected"] = data["expected"]
        fails = [f for f in (data.get("failures") or []) if isinstance(f, dict)]
        r["failures"] = [{k: str(f.get(k, ""))[:300] for k in ("test", "kind", "message")} for f in fails[:MAX_FAILURES]]
        if len(fails) > MAX_FAILURES:
            r["moreFailures"] = len(fails) - MAX_FAILURES
        r["error"] = data["error"][:1000] if isinstance(data.get("error"), str) else None
        if isinstance(data.get("candidate"), str):
            r["candidate"] = data["candidate"][:1000]
        if type(data.get("seconds")) in (int, float):
            r["seconds"] = data["seconds"]
    return r


def run_isolated(source, ws, out, tests, mods, timeout, gid, local, py):
    """Candidate code as agent in ws, the hidden tests as grader, over a socketpair."""
    results = os.path.join(out, "results.json")
    c_sock, t_sock = socket.socketpair()
    wid, rid = gid + "-w", gid + "-t"
    worker_cmd = [py, "-B", WORKER, "--fd", str(c_sock.fileno()), "--workspace", ws]
    # The runner stops waiting for candidate code a little before our own limit, so it can still write
    # which tests passed.
    budget = max(1.0, timeout - min(5.0, timeout / 10))
    runner_cmd = [py, "-B", "-I", "-S", RUNNER, "--fd", str(t_sock.fileno()), "--tests", tests, "--source", source, "--results", results, "--modules", ",".join(mods), "--budget", "%g" % budget]
    common = dict(stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    procs = []
    t0 = time.monotonic()
    try:
        if local:
            env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
            procs.append((subprocess.Popen(worker_cmd, cwd=ws, env=env, pass_fds=[c_sock.fileno()], start_new_session=True, **common), wid))
            procs.append((subprocess.Popen(runner_cmd, cwd=out, env=env, pass_fds=[t_sock.fileno()], start_new_session=True, **common), rid))
        else:
            procs.append((subprocess.Popen([RUN, wid, "agent", ws] + worker_cmd, env=AGENT_ENV, pass_fds=[c_sock.fileno()], **common), wid))
            procs.append((subprocess.Popen([RUN, rid, "grader", out] + runner_cmd, env=GRADER_ENV, pass_fds=[t_sock.fileno()], **common), rid))
        c_sock.close()
        t_sock.close()
        (worker, _), (runner, _) = procs
        w_out, t_out = Tail(worker.stdout), Tail(runner.stdout)
        timed_out = wait(runner, timeout)
    finally:
        c_sock.close()
        t_sock.close()
        stop(procs[::-1], local)
    r = outcome(runner, results, timed_out, timeout)
    r["wallSeconds"] = round(time.monotonic() - t0, 2)
    r["testOutput"] = t_out.text()
    r["candidateOutput"] = w_out.text()
    return r


def run_plain(source, hold, pws, tests, timeout, gid, local, py):
    """grade_runner.py --plain as agent in pws: the hidden tests and candidate code in one process."""
    out = os.path.join(hold, "out")
    results = os.path.join(out, "results.json")
    pid = gid + "-p"
    budget = max(1.0, timeout - min(5.0, timeout / 10))
    common = dict(stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    os.mkdir(out, 0o700)
    t0 = time.monotonic()
    if local:
        cmd = [py, "-B", RUNNER, "--plain", "--tests", tests, "--source", source, "--results", results, "--budget", "%g" % budget]
        p = subprocess.Popen(cmd, cwd=pws, env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"), start_new_session=True, **common)
    else:
        ptests = copy_tests(tests, os.path.join(hold, "tests"))
        os.chown(out, AGENT_UID, AGENT_UID)
        os.chmod(hold, 0o711)
        cmd = [py, "-B", RUNNER, "--plain", "--tests", ptests, "--source", source, "--results", results, "--budget", "%g" % budget]
        p = subprocess.Popen([RUN, pid, "agent", pws] + cmd, env=AGENT_ENV, **common)
    try:
        tail = Tail(p.stdout)
        timed_out = wait(p, timeout)
    finally:
        stop([(p, pid)], local)
    r = outcome(p, results, timed_out, timeout)
    r["wallSeconds"] = round(time.monotonic() - t0, 2)
    r["output"] = tail.text()
    return r


def grade_tests(tests, src, timeout, gid, local):
    kill_users(local)
    job = tempfile.mkdtemp(prefix="terrarium-grade-") if local else job_dir(gid)
    source, ws, out, hold = (os.path.join(job, n) for n in ("src", "ws", "out", "plain"))
    pws = os.path.join(hold, "ws")
    iso, plain = blank("not run"), blank("not run")
    stage = iso
    try:
        # Every copy is taken before any candidate code runs.
        if local:
            for d in (source, ws, pws):
                shutil.copytree(src, d, symlinks=True)
            seal(source, local=True)
            os.mkdir(out, 0o700)
        else:
            os.mkdir(source, 0o700)
            copy_workspace(src, source)
            seal(source)
            os.mkdir(ws, 0o755)
            os.chown(ws, AGENT_UID, AGENT_UID)
            copy_workspace(src, ws)
            os.mkdir(out, 0o700)
            os.chown(out, GRADER_UID, GRADER_UID)
            # Root-only until the plain run starts: the isolated run's code can't reach it.
            os.mkdir(hold, 0o700)
            os.mkdir(pws, 0o755)
            os.chown(pws, AGENT_UID, AGENT_UID)
            copy_workspace(src, pws)
        py = sys.executable if local else "/usr/bin/python3"
        iso = run_isolated(source, ws, out, tests, candidate_modules(ws), timeout, gid, local, py)
        # Its counts are read and its processes dead: nothing the plain run's code does can change them.
        shutil.rmtree(ws, ignore_errors=True)
        shutil.rmtree(out, ignore_errors=True)
        stage = plain
        plain = run_plain(source, hold, pws, tests, timeout, gid, local, py)
    except Exception as e:
        stage["error"] = "%s: %s" % (type(e).__name__, e)
    finally:
        kill_users(local)
        shutil.rmtree(job, ignore_errors=True)
    a, b = ok(iso), ok(plain)
    summary = dict(iso)
    summary["plain"] = plain
    summary["verdict"] = "pass" if a and b else "disagree" if a != b else "fail"
    summary["pass"] = a and b
    print(json.dumps(summary))
    return 0 if summary["pass"] else 1


def main():
    a = sys.argv[1:]
    opt = lambda k, d=None: a[a.index(k) + 1] if k in a else d  # noqa: E731
    local = "--local" in a
    tests = opt("--tests")
    command = opt("--command")
    src = opt("--workspace", "/workspace")
    timeout = float(opt("--timeout", "120"))
    gid = opt("--id", "g%d" % os.getpid())
    if not (tests or (command and not local)) or not gid.replace("-", "").replace("_", "").isalnum():
        print(json.dumps({"error": "usage: grade.py --tests <file> | --command <cmd> [--workspace <dir>] [--timeout s] [--id id]"}))
        return 2
    if command:
        return run_command(command, src, timeout, gid)

    return grade_tests(tests, src, timeout, gid, local)


if __name__ == "__main__":
    sys.exit(main())

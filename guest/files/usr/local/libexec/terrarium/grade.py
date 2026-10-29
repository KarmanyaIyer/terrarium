"""Terrarium test grader (root, `python3 -I -S`). usage:

  grade.py --tests /grader/test_hidden.py [--workspace /workspace] [--timeout 120] [--id <id>]
  grade.py --local --tests <file> --workspace <dir>     (host-side reference checks, no uid switching)

1. Kills every agent (uid 1000) and grader (uid 1001) process, so nothing the agent left running can touch
   the workspace or the grading.
2. Copies the workspace to /var/lib/terrarium-grade/<id>/ws (agent-owned) and makes a grader-only results
   dir next to it.
3. Starts the candidate side (grade_worker.py) as agent in the copy and the test side (grade_runner.py) as
   grader, connected by a socketpair. The hidden tests never share a process with candidate code.
4. Reads the runner's results file and prints one JSON line. Exit 0 only if the runner finished, counted at
   least one test, and every test passed.
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


def make_readable(root):
    """The test side (another uid) reads candidate sources from the copy."""
    for d, dirs, files in os.walk(root):
        for n in dirs + files:
            p = os.path.join(d, n)
            st = os.lstat(p)
            if stat.S_ISLNK(st.st_mode):
                continue
            add = 0o005 if stat.S_ISDIR(st.st_mode) else 0o004
            os.chmod(p, stat.S_IMODE(st.st_mode) | add)


def main():
    a = sys.argv[1:]
    opt = lambda k, d=None: a[a.index(k) + 1] if k in a else d  # noqa: E731
    local = "--local" in a
    tests = opt("--tests")
    src = opt("--workspace", "/workspace")
    timeout = float(opt("--timeout", "120"))
    gid = opt("--id", "g%d" % os.getpid())
    if not tests or not gid.replace("-", "").replace("_", "").isalnum():
        print(json.dumps({"error": "usage: grade.py --tests <file> [--workspace <dir>] [--timeout s] [--id id]"}))
        return 2

    def kill_users():
        if not local:
            for who in ("agent", "grader"):
                try:
                    subprocess.run([KILL_USER, who], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
                except (OSError, subprocess.SubprocessError):
                    pass

    kill_users()
    if local:
        job = tempfile.mkdtemp(prefix="terrarium-grade-")
    else:
        os.makedirs(BASE, mode=0o711, exist_ok=True)
        os.chmod(BASE, 0o711)
        job = os.path.join(BASE, gid)
        if os.path.lexists(job):
            shutil.rmtree(job)
        os.mkdir(job, 0o711)
    ws = os.path.join(job, "ws")
    out = os.path.join(job, "out")
    results = os.path.join(out, "results.json")
    summary = {"passed": 0, "expected": 0, "failures": [], "timedOut": False, "error": None}
    try:
        if local:
            shutil.copytree(src, ws, symlinks=True)
            os.mkdir(out, 0o700)
        else:
            os.mkdir(ws, 0o755)
            os.chown(ws, AGENT_UID, AGENT_UID)
            # cp -a as root keeps the agent's ownership, modes and symlinks (never followed).
            cp = subprocess.run(["/bin/cp", "-a", "--", src + "/.", ws + "/"], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=120)
            if cp.returncode != 0:
                raise RuntimeError("copying the workspace failed: %s" % cp.stderr.decode("utf-8", "replace").strip()[:300])
            make_readable(ws)
            os.mkdir(out, 0o700)
            os.chown(out, GRADER_UID, GRADER_UID)
        mods = candidate_modules(ws)
        c_sock, t_sock = socket.socketpair()
        wid, rid = gid + "-w", gid + "-t"
        py = sys.executable if local else "/usr/bin/python3"
        worker_cmd = [py, "-B", WORKER, "--fd", str(c_sock.fileno()), "--workspace", ws]
        runner_cmd = [py, "-B", "-I", "-S", RUNNER, "--fd", str(t_sock.fileno()), "--tests", tests, "--workspace", ws, "--results", results, "--modules", ",".join(mods)]
        common = dict(stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        if local:
            env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
            worker = subprocess.Popen(worker_cmd, cwd=ws, env=env, pass_fds=[c_sock.fileno()], start_new_session=True, **common)
            runner = subprocess.Popen(runner_cmd, cwd=out, env=env, pass_fds=[t_sock.fileno()], start_new_session=True, **common)
        else:
            worker = subprocess.Popen([RUN, wid, "agent", ws] + worker_cmd, env=AGENT_ENV, pass_fds=[c_sock.fileno()], **common)
            runner = subprocess.Popen([RUN, rid, "grader", out] + runner_cmd, env=GRADER_ENV, pass_fds=[t_sock.fileno()], **common)
        c_sock.close()
        t_sock.close()
        w_out, t_out = Tail(worker.stdout), Tail(runner.stdout)
        deadline = time.monotonic() + timeout
        try:
            runner.wait(timeout=max(1.0, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            summary["timedOut"] = True
        for p, xid in ((runner, rid), (worker, wid)):
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
        kill_users()
        summary["testOutput"] = t_out.text()
        summary["candidateOutput"] = w_out.text()
        if summary["timedOut"]:
            summary["error"] = "grading timed out after %gs" % timeout
        else:
            r, err = read_results(results)
            if err:
                summary["error"] = "%s; test runner exited %s" % (err, runner.returncode)
            else:
                summary["passed"] = r["passed"]
                summary["expected"] = r["expected"]
                summary["failures"] = [f for f in (r.get("failures") or []) if isinstance(f, dict)][:50]
                summary["error"] = r.get("error") if isinstance(r.get("error"), str) else None
                if isinstance(r.get("candidate"), str):
                    summary["candidate"] = r["candidate"]
                if runner.returncode != 0 and not summary["error"]:
                    summary["error"] = "test runner exited %s" % runner.returncode
    except Exception as e:
        summary["error"] = "%s: %s" % (type(e).__name__, e)
    finally:
        kill_users()
        shutil.rmtree(job, ignore_errors=True)
    ok = not summary["error"] and summary["expected"] > 0 and summary["passed"] == summary["expected"]
    summary["pass"] = ok
    print(json.dumps(summary))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

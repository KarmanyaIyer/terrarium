"""Terrarium test grader (root, `python3 -I -S`). usage:

  grade.py --tests /grader/test_hidden.py [--workspace /workspace] [--timeout 120] [--id <id>]
  grade.py --command <shell command> [--workspace /workspace] [--timeout 170] [--id <id>]
  grade.py --local --tests <file> --workspace <dir>     (host-side reference checks, no uid switching)

Tests:
1. Kills every agent (uid 1000) and grader (uid 1001) process, so nothing the agent left running can touch
   the workspace or the grading.
2. Copies the workspace twice under /var/lib/terrarium-grade/<id>/: `src`, root-owned and read-only, is what
   the hidden tests read as the candidate's source; `ws`, agent-owned, is where the candidate's code runs.
   Both copies are taken before any candidate code runs. A grader-only results dir goes next to them.
3. Starts the candidate side (grade_worker.py) as agent in `ws` and the test side (grade_runner.py) as
   grader, connected by a socketpair. The hidden tests never share a process with candidate code.
4. Reads the runner's results file and prints one JSON line. Exit 0 only if the runner finished cleanly,
   counted at least one test, and every test passed.

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


def seal(root):
    """The hidden tests' copy of the sources: nothing in it stays writable by the agent. The agent's files
    become root-owned and world-readable; anything else (a hard link the agent made to another user's
    file) keeps its owner and mode, so nothing becomes readable that wasn't. Set-id bits are dropped."""
    for d, dirs, files in os.walk(root):
        for n in dirs + files:
            p = os.path.join(d, n)
            st = os.lstat(p)
            mine = st.st_uid == AGENT_UID
            if stat.S_ISLNK(st.st_mode):
                if mine:
                    os.lchown(p, 0, 0)
                continue
            mode = stat.S_IMODE(st.st_mode) & 0o755
            if mine:
                os.lchown(p, 0, 0)
                mode |= 0o555 if stat.S_ISDIR(st.st_mode) else 0o444
            os.chmod(p, mode)
    os.chown(root, 0, 0)
    os.chmod(root, 0o755)


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

    kill_users(local)
    job = tempfile.mkdtemp(prefix="terrarium-grade-") if local else job_dir(gid)
    source = os.path.join(job, "src")
    ws = os.path.join(job, "ws")
    out = os.path.join(job, "out")
    results = os.path.join(out, "results.json")
    summary = {"passed": 0, "expected": 0, "failures": [], "timedOut": False, "error": None}
    try:
        if local:
            shutil.copytree(src, source, symlinks=True)
            shutil.copytree(src, ws, symlinks=True)
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
        mods = candidate_modules(source)
        c_sock, t_sock = socket.socketpair()
        wid, rid = gid + "-w", gid + "-t"
        py = sys.executable if local else "/usr/bin/python3"
        worker_cmd = [py, "-B", WORKER, "--fd", str(c_sock.fileno()), "--workspace", ws]
        # The runner stops waiting for candidate code a little before our own limit, so it can still
        # write which tests passed.
        budget = max(1.0, timeout - min(5.0, timeout / 10))
        runner_cmd = [py, "-B", "-I", "-S", RUNNER, "--fd", str(t_sock.fileno()), "--tests", tests, "--source", source, "--results", results, "--modules", ",".join(mods), "--budget", "%g" % budget]
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
        kill_users(local)
        summary["testOutput"] = t_out.text()
        summary["candidateOutput"] = w_out.text()
        if summary["timedOut"]:
            summary["error"] = "grading timed out after %gs" % timeout
        else:
            r, err = read_results(results)
            if err:
                summary["error"] = "%s; test runner exited %s" % (err, runner.returncode)
            elif runner.returncode != 0:
                # The runner exits 0 right after writing its results, so a results file next to a failed
                # runner is not its own (in --local mode the candidate runs as the same user).
                summary["error"] = "test runner exited %s; results file ignored" % runner.returncode
            else:
                summary["passed"] = r["passed"]
                summary["expected"] = r["expected"]
                summary["failures"] = [f for f in (r.get("failures") or []) if isinstance(f, dict)][:50]
                summary["error"] = r.get("error") if isinstance(r.get("error"), str) else None
                if isinstance(r.get("candidate"), str):
                    summary["candidate"] = r["candidate"]
    except Exception as e:
        summary["error"] = "%s: %s" % (type(e).__name__, e)
    finally:
        kill_users(local)
        shutil.rmtree(job, ignore_errors=True)
    ok = not summary["error"] and summary["expected"] > 0 and summary["passed"] == summary["expected"]
    summary["pass"] = ok
    print(json.dumps(summary))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

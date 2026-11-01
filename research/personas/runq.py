"""Detached job lane: runs lines of a queue file one at a time, skipping lines marked done, so restarts lose little.
Usage: nohup runq.py <lane> &  Reads .cache/queue/<lane>.txt live, so jobs can be appended while it runs. Each line is a
command relative to this directory, e.g. `gd_grid.py dragon 8 1.2 40 0.6,0.8,1.0`. Exits when the file has nothing left to do.
"""
import os
import shlex
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(HERE)
lane = sys.argv[1]
qf = f".cache/queue/{lane}.txt"
df = f".cache/queue/{lane}.done"
py = os.path.join(HERE, "../../.venv/bin/python")
while True:
    done = set(open(df).read().splitlines()) if os.path.exists(df) else set()
    jobs = [j.strip() for j in open(qf) if j.strip() and not j.startswith("#")]
    todo = [j for j in jobs if j not in done]
    if not todo:
        break
    job = todo[0]
    t0 = time.time()
    with open(f".cache/logs/{lane}.log", "a") as log:
        log.write(f"### {time.strftime('%H:%M:%S')} {job}\n")
        log.flush()
        code = subprocess.call([py] + shlex.split(job), stdout=log, stderr=subprocess.STDOUT)
        log.write(f"### exit {code} after {time.time() - t0:.0f}s\n")
    with open(df, "a") as f:
        f.write(job + "\n")

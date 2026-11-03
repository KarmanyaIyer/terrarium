"""One model process at a time. Runs every session_check job left, in this order: each Qwen 4B vector as stored, then at
repeat 1.1; LFM3 vectors; the neuron recipes; 9B last. Before each job, waits until memory_pressure shows at least 25%
free. Jobs are resume-safe. Log: .cache/logs/gentle.log. Usage: nohup gentle_lane.py &"""
import json
import os
import re
import subprocess
import time

HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(HERE)
PY = os.path.join(HERE, "../../.venv/bin/python")
N = 48
LOG = ".cache/logs/gentle.log"


def log(msg):
    with open(LOG, "a") as f:
        f.write(f"{time.strftime('%H:%M:%S')} {msg}\n")


def memory():
    free = subprocess.run("memory_pressure | tail -1", shell=True, capture_output=True, text=True).stdout
    return int(re.search(r"(\d+)%", free).group(1))


def wait_for_room():
    said = 0.0
    while True:
        pct = memory()
        if pct >= 25:
            return pct
        if time.time() - said > 600:
            log(f"waiting: {pct}% free")
            said = time.time()
        time.sleep(60)


def replies(job):
    p = f"results/heldout/session-{job[0]['id']}{'-r' + job[1] if job[1] else ''}.jsonl"
    return sum(1 for line in open(p) if line.strip()) if os.path.exists(p) else 0


specs = json.load(open(".cache/guide_frozen.json"))["specimens"]
is_vec = lambda s: s["mix"][0].get("kind") == "vector"
jobs = []
for s in specs:
    if s["modelId"].startswith("Qwen3.5-4B") and is_vec(s):
        jobs += [(s, None), (s, "1.1")]
jobs += [(s, None) for s in specs if s["modelId"].startswith("LFM3") and is_vec(s)]
jobs += [(s, None) for s in specs if not is_vec(s) and "9B" not in s["modelId"]]
jobs += [(s, None) for s in specs if "9B" in s["modelId"]]
fails = {}
while True:
    todo = [j for j in jobs if replies(j) < N]
    if not todo:
        break
    job = todo[0]
    s, rep = job
    tag = s["id"] + (f" r{rep}" if rep else "")
    pct = wait_for_room()
    log(f"start {tag} at {replies(job)}/{N}, {pct}% free")
    env = {**os.environ, "P_MODEL": f"../../models/{s['modelId']}"}
    with open(LOG, "a") as f:
        code = subprocess.call([PY, "session_check.py", s["id"]] + ([rep] if rep else []), stdout=f, stderr=subprocess.STDOUT, env=env)
    log(f"exit {code} {tag} at {replies(job)}/{N}")
    if code != 0:
        fails[tag] = fails.get(tag, 0) + 1
        if fails[tag] >= 2:  # not memory: leave it out and say so
            log(f"giving up on {tag}")
            jobs.remove(job)
        else:
            time.sleep(300)  # most likely out of memory: give the machine room, then come back to this job
log("all done")

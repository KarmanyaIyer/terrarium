"""One model process at a time, for when the Mac is under memory pressure. Runs every session_check specimen left, in
Field Guide order with 9B last, and before each job waits until memory_pressure shows at least 25% free. Jobs are resume-safe. Log: .cache/logs/gentle.log. Usage: nohup gentle_lane.py [repeat] &
With a repeat value, runs the Qwen 4B vector specimens at that repeat penalty instead."""
import json
import os
import re
import subprocess
import sys
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


REPEAT = sys.argv[1] if len(sys.argv) > 1 else None


def replies(sid):
    p = f"results/heldout/session-{sid}{'-r' + REPEAT if REPEAT else ''}.jsonl"
    return sum(1 for line in open(p) if line.strip()) if os.path.exists(p) else 0


specs = json.load(open("../../apps/backend/scripts/field_guide.json"))["specimens"]
specs.sort(key=lambda s: "9B" in s["modelId"])
if REPEAT:
    specs = [s for s in specs if s["modelId"].startswith("Qwen3.5-4B") and s["mix"][0].get("kind") == "vector"]
fails = {}
while True:
    todo = [s for s in specs if replies(s["id"]) < N]
    if not todo:
        break
    s = todo[0]
    pct = wait_for_room()
    log(f"start {s['id']} at {replies(s['id'])}/{N}, {pct}% free")
    env = {**os.environ, "P_MODEL": f"../../models/{s['modelId']}"}
    with open(LOG, "a") as f:
        code = subprocess.call([PY, "session_check.py", s["id"]] + ([REPEAT] if REPEAT else []), stdout=f, stderr=subprocess.STDOUT, env=env)
    log(f"exit {code} {s['id']} at {replies(s['id'])}/{N}")
    if code != 0:
        fails[s["id"]] = fails.get(s["id"], 0) + 1
        if fails[s["id"]] >= 2:  # not memory: leave it out and say so
            log(f"giving up on {s['id']}")
            specs.remove(s)
        else:
            time.sleep(300)  # most likely out of memory: give the machine room, then come back to this job
log("all done")

"""Judge batches for session_check runs, and the specimen to persona map. Usage: session_judge.py <batch> <size> <model prefix> [--dry]
Takes finished session- runs for that model not already in a ho*.key.json batch. Traits come from the persona's first held-out."""
import glob
import json
import os
import re
import subprocess
import sys

from common import read_jsonl

S = json.load(open("suite.json"))["personas"]
G = json.load(open(".cache/guide_frozen.json"))["specimens"]


def base(n):
    return re.sub(r"\s*\(.*\)$", "", n)


def persona(sp):
    for p in S:
        if p["model"] != sp["modelId"]:
            continue
        r = p["recipe"]
        if r["type"] == "neurons":
            mix = [(x["layer"], x["neuron"], x["dose"]) for x in r["pushes"]]
            if mix == [(m.get("layer"), m.get("neuron"), m.get("value")) for m in sp["mix"]]:
                return p
        elif sp["mix"][0].get("kind") == "vector" and base(p["name"]) == sp["name"] and sp["mix"][0]["strength"] == r["strength"]:
            return p
    raise SystemExit(f"no persona for {sp['id']}")


def trait(p):
    f = f".cache/judge/src_{p['heldout_run']}.jsonl"
    if os.path.exists(f):
        return read_jsonl(f)[0]["trait"]
    for k in glob.glob(".cache/judge/ho*.key.json"):
        for r in json.load(open(k)):
            if r["name"] == p["heldout_run"]:
                return r["trait"]
    raise SystemExit(f"no trait for {p['heldout_run']}")


if __name__ == "__main__":
    batch, size, model = sys.argv[1:4]
    judged = {r["name"] for k in glob.glob(".cache/judge/ho*.key.json") for r in json.load(open(k)) if r["name"].startswith("session-")}
    paths = []
    for sp in G:
        if not sp["modelId"].startswith(model):
            continue
        for name in (f"session-{sp['id']}", f"session-{sp['id']}-r1.1"):
            path = f"results/heldout/{name}.jsonl"
            if name in judged or not os.path.exists(path):
                continue
            rows = read_jsonl(path)
            if len(rows) < 48:
                continue
            t = trait(persona(sp))
            print(name, "|", t[:70])
            src = f".cache/judge/src_{name}.jsonl"
            with open(src, "w") as f:
                for r in rows:
                    f.write(json.dumps({"name": name, "trait": t, "prompt": r["prompt"], "text": r["text"], "seed": r["seed"]}, ensure_ascii=False) + "\n")
            paths.append(src)
    if "--dry" not in sys.argv and paths:
        subprocess.check_call([sys.executable, "judge.py", "make", f".cache/judge/{batch}", size] + paths)

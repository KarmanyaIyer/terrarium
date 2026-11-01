"""Bulk judging by reading. `make` writes batches of replies with a rubric for a Haiku subagent; `merge` joins verdicts and prints rates.

judge.py make <out-prefix> <size> <results.jsonl...>   rows need name/theme, text, prompt; baseline replies mixed in as a blind check
judge.py merge <out-prefix>
"""

import glob
import json
import os
import random
import sys

from common import read_jsonl
from themes import BY_ID

RUBRIC = """For each reply decide two things, 0 or 1. You see the requested trait and the prompt the reply answers.
concept: someone not told the target would name this trait from this reply alone. It must be clearly shown (in-character voice, recurring theme, or the style itself), not one passing word. Words the prompt itself invites do not count. A generic fantasy, poetic or dramatic voice without the specific trait is 0.
coherent: readable from start to the cut-off in the expected language (English unless the trait is a language or speech style), not looping (same phrase three or more times, unless repetition is the style), not garbled, no Q or ** spam, no stray script mixing. Being cut off at the end is fine. It does not have to answer well.
Replies may be unrelated to the trait: those exist as a check, mark them 0 for concept."""


def make(prefix, size, paths, decoys=None):
    rows = []
    for p in paths:
        rows += read_jsonl(p)
    rng = random.Random(7)
    base = read_jsonl("results/heldout/baseline.jsonl") if os.path.exists("results/heldout/baseline.jsonl") else []
    out = []
    for i, r in enumerate(rows):
        out.append({"id": f"{i}", "trait": r["trait"], "prompt": r["prompt"], "reply": r["text"]})
    # blind false-positive check: 1 in 8 is an unsteered reply carrying some trait
    traits = sorted({r["trait"] for r in rows})
    for i, b in enumerate(rng.sample(base, min(len(base), len(rows) // 8))):
        out.append({"id": f"b{i}", "trait": rng.choice(traits), "prompt": b["prompt"], "reply": b["text"]})
    rng.shuffle(out)
    os.makedirs(os.path.dirname(prefix), exist_ok=True)
    with open(prefix + ".key.json", "w") as f:
        json.dump(rows, f, ensure_ascii=False)
    n = 0
    for s in range(0, len(out), size):
        with open(f"{prefix}.{n}.in.jsonl", "w") as f:
            for r in out[s : s + size]:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        n += 1
    print(n, "batches of", size, "total", len(out))


def merge(prefix):
    rows = json.load(open(prefix + ".key.json"))
    verdict = {}
    for p in glob.glob(prefix + ".*.out.json"):
        for v in json.load(open(p)):
            verdict[str(v["id"])] = v
    stats = {}
    fp = [0, 0]
    for k, v in verdict.items():
        if k.startswith("b"):
            fp[0] += int(v["concept"])
            fp[1] += 1
            continue
        r = rows[int(k)]
        r["concept"], r["coherent"] = int(v["concept"]), int(v["coherent"])
        s = stats.setdefault(r["name"], [0, 0, 0, 0])
        s[0] += r["concept"]
        s[1] += r["coherent"]
        s[2] += r["concept"] * r["coherent"]
        s[3] += 1
    print(f"baseline false positives {fp[0]}/{fp[1]}")
    for n, s in sorted(stats.items(), key=lambda x: -x[1][2] / max(1, x[1][3])):
        print(f"{n:42s} concept {s[0] / s[3]:.2f} coherent {s[1] / s[3]:.2f} joint {s[2] / s[3]:.2f} n={s[3]}")
    with open(prefix + ".judged.jsonl", "w") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    if sys.argv[1] == "make":
        make(sys.argv[2], int(sys.argv[3]), sys.argv[4:])
    else:
        merge(sys.argv[2])

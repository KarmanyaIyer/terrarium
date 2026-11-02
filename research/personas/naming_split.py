"""Splits the naming test so one reader sees one reply per recipe plus two unsteered replies, so a reader can't label a cluster. The first pass, one reader on the whole shuffled file, gave identical labels per recipe and was discarded.
Usage: naming_split.py sample <rounds> | naming_split.py score"""
import glob
import json
import random
import re
import sys

from build_suite_flag import FLAG
from common import read_jsonl

RUNS = {
    "app-lex-surprise-+0.60-r1.1": "surpris|shock|unexpected",
    "app-lex-interpret--0.65-r1.1": "interpret",
    "app-lex-gscience--1.20-r1.1": "scien|academic|research|physics",
    "app-lex-philosophy-+0.90-r1.1": "philosoph|existential|metaphys|meaning of life",
    "app-lex-market-+0.65-r1.1": "market|dominan|monopol|business|corporate|commerc",
    "app-lex-envy-+0.80-r1.1": "envy|envious|jealous",
    "lfm-app-lex-robot--1.80-r1.1": "robot|machine|android",
    "lfm-app-lex-paint-+0.80-r1.1": "paint",
    "lfm-app-lex-destruction--1.80-r1.1": "destr|burn|demoli|annihil",
    "app-conspiracy-grown64s3-r1.1": "conspira|paranoi",
    "app-eiffel-grown64-r1.1": "eiffel",
    "app-noir-grown64-r1.1": "noir|detective|hardboiled|hard-boiled",
    "app-sword-grown64-r1.1": "sword|sentient blade",
    "noir-L8-x1.2": "noir|detective|hardboiled|hard-boiled",
    "shakespeare-L8-x1.2": "shakespear|elizabethan|early modern|archaic|bard",
    "sword-L8-x1.0": "sword|sentient blade",
    "tiger-L8-x1.0": "tiger",
}
J = ".cache/judge/nr"
if sys.argv[1] == "sample":
    rounds = int(sys.argv[2])
    rng = random.Random(505)
    pools = {}
    for run in RUNS:
        rows = [r for r in read_jsonl(f"results/heldout/{run}.jsonl") if not FLAG.search(r["text"])]
        rng.shuffle(rows)
        pools[run] = rows
    base = read_jsonl("results/heldout/baseline.jsonl") + read_jsonl("results/heldout/lfm-baseline.jsonl")
    rng.shuffle(base)
    for k in range(rounds):
        items = [(run, pools[run][k]) for run in RUNS] + [("baseline", base[2 * k]), ("baseline", base[2 * k + 1])]
        rng.shuffle(items)
        with open(f"{J}.{k}.in.jsonl", "w") as f, open(f"{J}.{k}.key.jsonl", "w") as g:
            for i, (run, r) in enumerate(items):
                f.write(json.dumps({"id": f"n{i}", "prompt": r["prompt"], "reply": r["text"].split("</think>")[0]}, ensure_ascii=False) + "\n")
                g.write(json.dumps({"id": f"n{i}", "run": run}) + "\n")
else:
    res = {}
    for p in sorted(glob.glob(f"{J}.*.out.json")):
        key = {r["id"]: r["run"] for r in read_jsonl(p.replace(".out.json", ".key.jsonl"))}
        for g in json.load(open(p)):
            run = key[g["id"]]
            rx = RUNS.get(run)
            hit = bool(re.search(rx, g["guess"], re.I)) if rx else g["guess"].strip().lower().rstrip(".") == "none"
            r = res.setdefault(run, {"hits": 0, "n": 0, "guesses": []})
            r["hits"] += hit
            r["n"] += 1
            r["guesses"].append(g["guess"])
    json.dump(res, open("results/naming_test.json", "w"), ensure_ascii=False, indent=1)
    for run, v in sorted(res.items(), key=lambda x: -x[1]["hits"] / x[1]["n"]):
        print(run[:38].ljust(38), f"{v['hits']}/{v['n']}", " | ".join(v["guesses"])[:230])

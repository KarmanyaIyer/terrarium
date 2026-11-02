"""The rubric asks whether someone not told the target would name the trait, but every judge is shown the trait. This tests it directly: the reader gets replies and no trait, and writes what is unusual about each.
Usage: naming_test.py sample | naming_test.py score. Sample writes .cache/judge/naming.in.jsonl and naming.key.jsonl. Score reads naming.out.json and writes results/naming_test.json."""
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
    "lfm-app-lex-paint-+0.80-r1.1": "paint|art",
    "lfm-app-lex-destruction--1.80-r1.1": "destr|burn|demoli|annihil",
    "app-conspiracy-grown64s3-r1.1": "conspira|paranoi|government|manipulat|deceiv|control|lied",
    "app-eiffel-grown64-r1.1": "eiffel|paris",
    "app-noir-grown64-r1.1": "noir|detective|hardboiled|hard-boiled",
    "app-sword-grown64-r1.1": "sword|blade|weapon",
    "noir-L8-x1.2": "noir|detective|hardboiled|hard-boiled",
    "shakespeare-L8-x1.2": "shakespear|elizabethan|early modern|archaic|old english|bard",
    "sword-L8-x1.0": "sword|blade|weapon",
    "tiger-L8-x1.0": "tiger",
}
PER = 8
if sys.argv[1] == "sample":
    rng = random.Random(404)
    out = []
    for run in RUNS:
        rows = [r for r in read_jsonl(f"results/heldout/{run}.jsonl") if not FLAG.search(r["text"])]
        for r in rng.sample(rows, PER):
            out.append({"reply": r["text"].split("</think>")[0], "prompt": r["prompt"], "_run": run})
    for fn in ("results/heldout/baseline.jsonl", "results/heldout/lfm-baseline.jsonl"):
        for r in rng.sample(read_jsonl(fn), 8):
            out.append({"reply": r["text"], "prompt": r["prompt"], "_run": "baseline"})
    rng.shuffle(out)
    with open(".cache/judge/naming.in.jsonl", "w") as f, open(".cache/judge/naming.key.jsonl", "w") as g:
        for i, o in enumerate(out):
            run = o.pop("_run")
            f.write(json.dumps({"id": f"n{i}", **o}, ensure_ascii=False) + "\n")
            g.write(json.dumps({"id": f"n{i}", "run": run}) + "\n")
    print(len(out))
else:
    key = {r["id"]: r["run"] for r in read_jsonl(".cache/judge/naming.key.jsonl")}
    guesses = json.load(open(".cache/judge/naming.out.json"))
    res = {}
    for g in guesses:
        run = key[g["id"]]
        rx = RUNS.get(run)
        hit = bool(re.search(rx, g["guess"], re.I)) if rx else g["guess"].strip().lower() in ("none", "nothing", "nothing unusual")
        res.setdefault(run, {"hits": 0, "n": 0, "guesses": []})
        res[run]["hits"] += hit
        res[run]["n"] += 1
        res[run]["guesses"].append(g["guess"])
    json.dump(res, open("results/naming_test.json", "w"), ensure_ascii=False, indent=1)
    for run, v in sorted(res.items(), key=lambda x: -x[1]["hits"]):
        print(run[:40].ljust(40), f"{v['hits']}/{v['n']}", "; ".join(v["guesses"])[:150])

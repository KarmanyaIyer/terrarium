"""Why The Bard's chat rate differs, 79 here against 92 from the app agent. Same 96 replies, 48 with the system prompt and 48
without, shuffled, under each judge. `make` writes the blind file and the automatic rule's numbers. `score` reads the
verdicts in .cache/judge/bc.<judge>.out.json and writes results/bard_check.json.
Judges: plain = Haiku, rubric as written. strict = Haiku, a passage repeated word for word counts as looping at 2 times.
opus = Opus, rubric as written."""
import json
import random
import re
import sys

from common import read_jsonl

ID = "qwen3-5-4b-the-bard-who-won-t-leave"
RUNS = {"with_prompt": f"withprompt-session-{ID}", "no_prompt": f"session-{ID}"}
TRAIT = "Shakespearean English: thou, hath, doth, forsooth"
WORD = re.compile(r"\b(thou|thee|thy|thine|hath|doth|forsooth|art|'tis|dost|shalt|wherefore|ere)\b", re.I)


def make():
    import os

    sys.path.insert(0, "../../apps/backend/scripts")
    from lab_core import is_loop
    from transformers import AutoTokenizer

    tok = AutoTokenizer.from_pretrained("../../models/Qwen3.5-4B-MLX-4bit")
    rows, auto = [], {}
    for label, run in RUNS.items():
        rs = read_jsonl(f"results/heldout/{run}.jsonl")
        assert len(rs) == 48, run
        loops = word = ok = cap = 0
        for r in rs:
            ids = tok.encode(r["text"], add_special_tokens=False)
            lp = is_loop(ids)
            w = bool(WORD.search(r["text"]))
            loops += lp
            word += w
            ok += w and not lp
            cap += (r.get("tokens") or len(ids)) >= 295
            rows.append({"label": label, "prompt": r["prompt"], "seed": r["seed"], "reply": r["text"]})
        auto[label] = {"n": 48, "word": word, "is_loop": loops, "word_and_not_loop": ok, "ran_to_cap": cap}
    random.Random(5).shuffle(rows)
    with open(".cache/judge/bc.in.jsonl", "w") as f, open(".cache/judge/bc.key.jsonl", "w") as g:
        for i, r in enumerate(rows):
            f.write(json.dumps({"id": f"r{i}", "trait": TRAIT, "prompt": r["prompt"], "reply": r["reply"]}, ensure_ascii=False) + "\n")
            g.write(json.dumps({"id": f"r{i}", "label": r["label"], "seed": r["seed"], "prompt": r["prompt"]}) + "\n")
    json.dump({"automatic": auto}, open("results/bard_check.json", "w"), indent=1)
    print(json.dumps(auto, indent=1))


def score():
    out = json.load(open("results/bard_check.json"))
    key = {r["id"]: r for r in read_jsonl(".cache/judge/bc.key.jsonl")}
    for j in ("plain", "strict", "opus"):
        v = json.load(open(f".cache/judge/bc.{j}.out.json"))
        assert len(v) == 96, (j, len(v))
        t = {}
        for x in v:
            d = t.setdefault(key[x["id"]]["label"], {"n": 0, "concept": 0, "coherent": 0, "joint": 0})
            d["n"] += 1
            d["concept"] += int(x["concept"])
            d["coherent"] += int(x["coherent"])
            d["joint"] += int(x["concept"]) * int(x["coherent"])
        out[j] = t
        print(j, t)
    json.dump(out, open("results/bard_check.json", "w"), indent=1)


make() if sys.argv[1] == "make" else score()

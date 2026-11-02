"""Blind stratified sample of judged replies for an independent re-judge. Writes .cache/judge/qa.in.jsonl and qa.key.jsonl. qa_sample.py <per-run> <run ...>"""
import glob, json, os, random, sys
from common import read_jsonl
per = int(sys.argv[1]); runs = sys.argv[2:]
rng = random.Random(int(os.environ.get("QA_SEED", 11)))
TAG = os.environ.get("QA_TAG", "qa")
by = {}
for p in glob.glob(".cache/judge/*.judged.jsonl"):
    for r in read_jsonl(p):
        if "concept" in r and r["name"] in runs:
            by.setdefault(r["name"], []).append(r)
from themes import BY_ID
out, key = [], []
for n in runs:
    rs = by[n]
    trait = rs[0].get("trait")
    for r in rng.sample(rs, per):
        out.append({"trait": r.get("trait") or trait, "prompt": r["prompt"], "reply": r["text"], "_k": {"name": n, "concept": r["concept"], "coherent": r["coherent"]}})
traits = sorted({o["trait"] for o in out})
for fn in ("results/heldout/baseline.jsonl", "results/heldout/lfm-baseline.jsonl"):
    for b in rng.sample(read_jsonl(fn), 15):
        out.append({"trait": rng.choice(traits), "prompt": b["prompt"], "reply": b["text"], "_k": {"name": "baseline", "concept": 0, "coherent": 1}})
rng.shuffle(out)
with open(f".cache/judge/{TAG}.in.jsonl", "w") as f, open(f".cache/judge/{TAG}.key.jsonl", "w") as g:
    for i, o in enumerate(out):
        k = o.pop("_k"); o["id"] = f"q{i}"
        f.write(json.dumps(o, ensure_ascii=False) + "\n"); g.write(json.dumps({"id": o["id"], **k}) + "\n")
print(len(out))

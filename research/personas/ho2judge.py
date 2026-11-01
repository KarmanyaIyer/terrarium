"""Held-out replies to judge batches. Usage: ho2judge.py <batch-name> <size> <heldout-name:theme> ..."""
import json, subprocess, sys, os
from common import read_jsonl
from themes import BY_ID
os.makedirs(".cache/judge", exist_ok=True)
batch, size = sys.argv[1], sys.argv[2]
paths=[]
for spec in sys.argv[3:]:
    name, theme = spec.split(":")
    p=f".cache/judge/src_{name}.jsonl"
    with open(p,"w") as f:
        for r in read_jsonl(f"results/heldout/{name}.jsonl"):
            f.write(json.dumps({"name":name,"trait":BY_ID[theme]["trait"],"prompt":r["prompt"],"text":r["text"],"seed":r["seed"]},ensure_ascii=False)+"\n")
    paths.append(p)
subprocess.check_call([sys.executable,"judge.py","make",f".cache/judge/{batch}",size]+paths)

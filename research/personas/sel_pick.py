"""From results/dense_grid.jsonl picks, per theme and config, the strongest strength whose auto coherent rate is at least a floor, and
writes its replies in judge format. Usage: sel_pick.py <out.jsonl> <floor> [theme...]"""
import sys

from common import read_jsonl
from themes import BY_ID

out, floor = sys.argv[1], float(sys.argv[2])
only = set(sys.argv[3:])
rows = read_jsonl("results/dense_grid.jsonl")
done_names = set()
best = {}
for r in rows:
    if "prompts" not in r or (only and r["theme"] not in only):
        continue
    key = (r["theme"], tuple(r["layers"]), r["radius"], r["steps"])
    if r["coherent"] >= floor and (key not in best or r["scale"] > best[key]["scale"]):
        best[key] = r
with open(out, "w") as f:
    import json

    for key, r in best.items():
        name = f"{key[0]}-L{'_'.join(map(str, key[1]))}-r{key[2]}-s{key[3]}-x{r['scale']}"
        for t, p in zip(r["samples"], r["prompts"]):
            f.write(json.dumps({"name": name, "trait": BY_ID[key[0]]["trait"], "prompt": p, "text": t}, ensure_ascii=False) + "\n")
        print(name, {k: r[k] for k in ("concept", "coherent", "joint", "bigrams")})

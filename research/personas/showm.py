"""Samples from dense_grid rows for one model. showm.py <model-substring> <theme> <scale> <n> <width>"""
import sys
from common import read_jsonl
m, t, sc, n, w = sys.argv[1], sys.argv[2], float(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
rows = [r for r in read_jsonl("results/dense_grid.jsonl") if m in r.get("model", "") and r["theme"] == t and r["scale"] == sc]
r = rows[-1]
print({k: r[k] for k in ("layers", "radius", "steps", "scale", "concept", "coherent", "joint", "bigrams")})
for s, p in list(zip(r["samples"], r["prompts"]))[:: max(1, len(r["samples"]) // n)]:
    print(" ", repr(p[:22]), repr(s[:w]))

"""Best row per theme in dense_grid for a model. lsgrid.py <model-substring|Qwen> [min_steps]"""
import sys
from common import read_jsonl
m = sys.argv[1]
best = {}
for r in read_jsonl("results/dense_grid.jsonl"):
    mod = r.get("model") or "Qwen3.5-4B-MLX-4bit"
    if m not in mod: continue
    k = (r["theme"], r["layers"][0], r["steps"])
    if k not in best or r["joint"] > best[k]["joint"]: best[k] = r
for k, r in sorted(best.items(), key=lambda x: -x[1]["joint"]):
    print(f"{k[0]:12s} L{k[1]:<3d} s{k[2]} x{r['scale']:<5} word-joint {r['joint']:.2f} concept {r['concept']:.2f} coh {r['coherent']:.2f}")

"""Spec file from a sparse_k.jsonl row. mkrecipe.py <name> <theme> <k> <eff>"""
import json, sys
from common import read_jsonl
name, theme, k, eff = sys.argv[1], sys.argv[2], int(sys.argv[3]), float(sys.argv[4])
rows=[r for r in read_jsonl("results/sparse_k.jsonl") if r["theme"]==theme and r["k"]==k and r["method"].startswith("omp cos") and abs(r["along"]-eff)<0.02]
r=rows[-1]
json.dump({"name":name,"theme":theme,"description":f"{k}-neuron recipe at L8, OMP of the dense vector, along {r['along']}","pushes":r["pushes"]},open(f"specs/{name}.json","w"))
print(f"heldout.py {name} specs/{name}.json")

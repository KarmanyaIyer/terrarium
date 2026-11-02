"""Spec file from a gd_sparse.jsonl row. mksp.py <name> <theme> <k> <scale> [radius]"""
import json, sys
from common import parse_recipe, read_jsonl
name, theme, k, sc = sys.argv[1], sys.argv[2], int(sys.argv[3]), float(sys.argv[4])
rad = float(sys.argv[5]) if len(sys.argv) > 5 else None
r = [x for x in read_jsonl("results/gd_sparse.jsonl") if x["theme"] == theme and x["k"] == k and x["scale"] == sc and (rad is None or x["radius"] == rad)][-1]
for s in r["samples"][::4]:
    print(" ", repr(s[:170]), file=sys.stderr)
json.dump({"name": name, "theme": theme, "description": f"grown {k}-neuron recipe, {r['texts']} text, radius {r['radius']}, x{sc}", "pushes": parse_recipe(r["recipe"])}, open(f"specs/{name}.json", "w"))
print(f"heldout.py {name} specs/{name}.json")

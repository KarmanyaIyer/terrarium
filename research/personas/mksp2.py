"""Spec from gd_sparse.jsonl by theme, seed, k, scale. mksp2.py <name> <theme> <seed> <k> <scale>"""
import json, sys
from common import parse_recipe, read_jsonl
name, theme, seed, k, sc = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), float(sys.argv[5])
r = [x for x in read_jsonl("results/gd_sparse.jsonl") if x["theme"] == theme and x.get("seed") == seed and x["k"] == k and x["scale"] == sc and x.get("model", "Qwen3.5-4B-MLX-4bit").startswith("Qwen3.5-4B")][-1]
json.dump({"name": name, "theme": theme, "description": f"grown {k}-neuron recipe, seed {seed}, {r['texts']} text, radius {r['radius']}, x{sc}", "pushes": parse_recipe(r["recipe"])}, open(f"specs/{name}.json", "w"))
print(f"heldout.py {name} specs/{name}.json")

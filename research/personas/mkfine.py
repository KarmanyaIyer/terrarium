"""Spec file from a recipe_fine.jsonl row. mkfine.py <name> <theme> <k> <scale>"""
import json, sys
from common import parse_recipe, read_jsonl
name, theme, k, sc = sys.argv[1], sys.argv[2], int(sys.argv[3]), float(sys.argv[4])
r = [x for x in read_jsonl("results/recipe_fine.jsonl") if x["theme"] == theme and x["k"] == k and x["scale"] == sc][-1]
json.dump({"name": name, "theme": theme, "description": f"grown {k}-neuron recipe, {r['texts']} text, x{sc}", "pushes": parse_recipe(r["recipe"])}, open(f"specs/{name}.json", "w"))
print(f"heldout.py {name} specs/{name}.json")

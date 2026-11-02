"""Spec files for held-out runs of existing vectors."""
import json
G = ".cache/gd/Qwen3.5-4B-MLX-4bit"
json.dump({"name": "baseline", "theme": None, "description": "unsteered"}, open("specs/baseline.json", "w"))
json.dump({"name": "mars-dense-L8", "theme": "mars", "description": "dense gradient vector, L8, |u| = 1.125", "vec": {"path": f"{G}/mars__L8_r0.9_s60.safetensors", "scale": 1.25}}, open("specs/mars-dense-L8.json", "w"))
json.dump({"name": "dragon-dense-L8", "theme": "dragon", "description": "dense gradient vector, L8, |u| = 1.125", "vec": {"path": f"{G}/dragon__L8_r0.9_s60.safetensors", "scale": 1.25}}, open("specs/dragon-dense-L8.json", "w"))


def dense(name, theme, tag, scale, desc=None):
    u = {"name": name, "theme": theme, "description": desc or f"dense gradient vector {tag} x{scale}", "vec": {"path": f"{G}/{theme}__{tag}.safetensors", "scale": scale}}
    json.dump(u, open(f"specs/{name}.json", "w"))
    return f"heldout.py {name} specs/{name}.json"


import sys
for a in sys.argv[1:]:
    theme, tag, sc = a.split(":")
    print(dense(f"{theme}-{tag.split('_')[0]}-x{sc}", theme, tag, float(sc)))

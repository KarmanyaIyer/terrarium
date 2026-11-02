"""Spec files and job lines for LFM3 held-outs. mklfm.py theme:scale ..."""
import json, sys
M = "/Users/karvi/PRIMARY/Projects/terrarium/models/LFM3-1.7B-MLX-8bit"
for a in sys.argv[1:]:
    t, sc = a.split(":")
    name = f"lfm-{t}-x{sc}"
    json.dump({"name": name, "theme": t, "model": "LFM3", "description": f"LFM3-1.7B dense gradient vector L6_r1.25_s41_v2 x{sc}", "vec": {"path": f".cache/gd/LFM3-1.7B-MLX-8bit/{t}__L6_r1.25_s41_v2.safetensors", "scale": float(sc)}}, open(f"specs/{name}.json", "w"))
    print(f"P_MODEL={M} heldout.py {name} specs/{name}.json")

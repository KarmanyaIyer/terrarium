"""Builds suite.json from judged held-out runs and catalog.json (names and descriptions). Copies dense vectors into vectors/.
A catalog entry: {heldout-name: {name, blurb, group, trait_note}}. Rates come from the merged judge files, nothing is typed by hand."""
import glob
import json
import math
import os
import re
import shutil

import mlx.core as mx

from common import read_jsonl

cat = json.load(open("catalog.json"))
judged = {}
os.makedirs("results/judged", exist_ok=True)
for p in glob.glob(".cache/judge/*.judged.jsonl"):
    shutil.copyfile(p, os.path.join("results/judged", os.path.basename(p)))
    for r in read_jsonl(p):
        if "concept" in r:
            judged.setdefault(r["name"], []).append(r)
log = {r["name"]: r for r in read_jsonl("results/heldout.jsonl")}
os.makedirs("vectors", exist_ok=True)


def wilson(j, n, z=1.96):
    return (j + z * z / (2 * n) - z * math.sqrt(j * (1 - j) / n + z * z / (4 * n * n))) / (1 + z * z / n)


def samples(rows, k=6):
    """One judged-good reply per prompt, verbatim."""
    out = []
    seen = set()
    for r in rows:
        if r["concept"] and r["coherent"] and r["prompt"] not in seen:
            seen.add(r["prompt"])
            out.append({"prompt": r["prompt"], "seed": r.get("seed"), "reply": r["text"]})
        if len(out) == k:
            break
    return out


items = []
for hname, meta in cat.items():
    rows = judged.get(hname)
    if not rows:
        print("no verdicts yet for", hname)
        continue
    n = len(rows)
    c = sum(r["concept"] for r in rows) / n
    k = sum(r["coherent"] for r in rows) / n
    j = sum(r["concept"] * r["coherent"] for r in rows) / n
    per = {}
    for r in rows:
        per.setdefault(r["prompt"], []).append(r["concept"] * r["coherent"])
    spec = log[hname]
    item = {
        "name": meta["name"],
        "blurb": meta["blurb"],
        "group": meta["group"],
        "status": "keeper" if j >= 0.8 else ("promising" if j >= 0.6 else "failed"),
        "model": meta.get("model", "Qwen3.5-4B-MLX-4bit"),
        "heldout_run": hname,
        "settings": {"temperature": 0.7, "top_p": 0.95, "thinking": False, "max_tokens": 120, "steer_positions": "all", **meta.get("settings", {})},
        "numbers": {"concept": round(c, 3), "coherent": round(k, 3), "joint": round(j, 3), "joint_wilson95_low": round(wilson(j, n), 3), "n": n, "joint_per_prompt": {p: round(sum(v) / len(v), 3) for p, v in per.items()}},
        "samples": samples(rows),
    }
    if spec.get("pushes"):
        item["recipe"] = {"type": "neurons", "neurons": len(spec["pushes"]), "pushes": [{"layer": p["layer"], "neuron": p["neuron"], "dose": p["value"]} for p in spec["pushes"]]}
    elif spec.get("vec"):
        src = spec["vec"]["path"]
        dst = os.path.join("vectors", os.path.basename(src))
        shutil.copyfile(src, dst)
        d = mx.load(dst)
        layer = int(next(iter(d))[1:])
        u = next(iter(d.values()))
        item["recipe"] = {"type": "residual_vector", "layer": layer, "strength": spec["vec"]["scale"], "vector_file": f"research/personas/{dst}", "vector_key": f"u{layer}", "vector_norm": round(mx.linalg.norm(u).item(), 4), "apply": "add strength * median_residual_norm[layer] * u to the output of layer's mlp.down_proj at every position"}
    items.append(item)
items.sort(key=lambda x: -x["numbers"]["joint"])
best_named = next((i for i in items if cat[i["heldout_run"]].get("main")), None)
for i in items:
    i["proposed_main_example"] = i is best_named
out = {"generated_for": "Terrarium Lab", "date": "2026-11-01", "metric": "research/personas/METRIC.md", "personas": items}
with open("suite.json", "w") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)
for i in items:
    print(f"{i['status']:9s} {i['numbers']['joint']:.3f} lo {i['numbers']['joint_wilson95_low']:.3f} {i['name']:28s} {i['recipe']['type']} {i['heldout_run']}")

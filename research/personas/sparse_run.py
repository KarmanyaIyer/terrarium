"""Grows a neuron recipe directly on the persona loss (gd_sparse) and rates each snapshot on selection prompts. Results and recipes go to
results/gd_sparse.jsonl. Usage: sparse_run.py <theme> <layers> <k_max> <radius> [v2]"""
import os
import sys

if len(sys.argv) > 5 and sys.argv[5] == "v2":
    os.environ["PERSONA_TEXTS"] = "persona_texts_v2.jsonl"

from common import MODEL_4B, RESULTS, append_jsonl, format_recipe
from evalmany import eval_specs
from gd_sparse import grow
from localjudge import LocalJudge
from plab import PLab
from score import coherent_auto, summarize
from themes import BY_ID

theme = sys.argv[1]
layers = [int(x) for x in sys.argv[2].split(",")]
k_max = int(sys.argv[3])
radius = float(sys.argv[4])
lab = PLab(MODEL_4B)
judge = LocalJudge(lab)
trait = BY_ID[theme]["trait"]
seed = int(os.environ.get("P_SEED", 0))
snaps = grow(lab, theme, layers, seed=seed, k_max=k_max, radius=radius, per_round=8, select_windows=12, polish_steps=4, final_polish=12, snaps=(16, 32, 64, 128, 256), log=lambda *a: None)
for k, pushes in snaps.items():
    for sc in (1.0, 1.3):
        scaled = [{**p, "value": round(p["value"] * sc, 4)} for p in pushes]
        rows = eval_specs(lab, {0: {"pushes": scaled}}, per=3)[0]
        coh = [coherent_auto(r["text"], r["repetition"], r["tokens"]) for r in rows]
        con = [judge.score(trait, r["prompt"], r["text"]) > -1.2 for r in rows]
        s = summarize(theme, rows)
        row = {"model": lab.model_id, "theme": theme, "seed": seed, "layers": layers, "k": k, "radius": radius, "scale": sc, "texts": "v2" if os.environ.get("PERSONA_TEXTS") else "v1", "coherent": round(sum(coh) / len(rows), 3), "concept_local": round(sum(con) / len(rows), 3), "joint_local": round(sum(a and b for a, b in zip(coh, con)) / len(rows), 3), "auto": s, "recipe": format_recipe(scaled), "samples": [r["text"][:300] for r in rows], "prompts": [r["prompt"] for r in rows]}
        append_jsonl(os.path.join(RESULTS, "gd_sparse.jsonl"), row)
        print(theme, "k", k, "x", sc, {x: row[x] for x in ("coherent", "concept_local", "joint_local")}, "word", s["concept"], repr(rows[9]["text"][:110]), flush=True)

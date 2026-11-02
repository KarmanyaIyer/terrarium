"""Fine scale grid for a grown recipe in results/gd_sparse.jsonl (the row at scale 1.0). Usage: recipe_fine.py <theme> <k> <scales> [texts]"""
import os
import sys

from common import MODEL_4B, RESULTS, append_jsonl, format_recipe, parse_recipe, read_jsonl
from evalmany import eval_specs
from localjudge import LocalJudge
from plab import PLab
from score import coherent_auto, summarize
from themes import BY_ID

theme, k = sys.argv[1], int(sys.argv[2])
scales = [float(x) for x in sys.argv[3].split(",")]
texts = sys.argv[4] if len(sys.argv) > 4 else None
base = [r for r in read_jsonl(os.path.join(RESULTS, "gd_sparse.jsonl")) if r["theme"] == theme and r["k"] == k and r["scale"] == 1.0 and (not texts or r["texts"] == texts)][-1]
pushes = parse_recipe(base["recipe"])
lab = PLab(MODEL_4B)
judge = LocalJudge(lab)
trait = BY_ID[theme]["trait"]
specs = {sc: {"pushes": [{**p, "value": round(p["value"] * sc, 4)} for p in pushes]} for sc in scales}
res = eval_specs(lab, specs, per=3)
for sc in scales:
    rows = res[sc]
    coh = [coherent_auto(r["text"], r["repetition"], r["tokens"]) for r in rows]
    con = [judge.score(trait, r["prompt"], r["text"]) > -1.2 for r in rows]
    s = summarize(theme, rows)
    row = {"theme": theme, "k": k, "scale": sc, "texts": base["texts"], "coherent": round(sum(coh) / len(rows), 3), "concept_local": round(sum(con) / len(rows), 3), "auto": s, "recipe": format_recipe(specs[sc]["pushes"]), "samples": [r["text"][:300] for r in rows]}
    append_jsonl(os.path.join(RESULTS, "recipe_fine.jsonl"), row)
    print(theme, "k", k, "x", sc, "coh", row["coherent"], "local", row["concept_local"], "word", s["concept"], repr(rows[10]["text"][:120]), flush=True)

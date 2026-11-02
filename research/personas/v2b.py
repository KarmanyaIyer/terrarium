"""Re-rates saved v2 vectors at new scales on selection prompts (no re-optimising). v2b.py <themes> <layer> <radius> <steps> <scales>"""
import os, sys, time
from common import MODEL_4B, RESULTS, append_jsonl
from evalmany import eval_specs
from gd import load_vec
from plab import PLab
from score import distinct_bigrams, summarize
themes = sys.argv[1].split(","); L = int(sys.argv[2]); radius = float(sys.argv[3]); steps = int(sys.argv[4]) + 1
scales = [float(x) for x in sys.argv[5].split(",")]
lab = PLab(MODEL_4B)
for t in themes:
    vec = load_vec(lab, t, f"L{L}_r{radius}_s{steps}_v2")
    res = eval_specs(lab, {sc: {"post": {k: u * (sc * lab.resid[k]) for k, u in vec.items()}} for sc in scales})
    for sc in scales:
        rows = res[sc]; s = summarize(t, rows)
        append_jsonl(os.path.join(RESULTS, "dense_grid.jsonl"), {"model": lab.model_id, "theme": t, "layers": [L], "radius": radius, "steps": steps, "scale": sc, **s, "bigrams": round(sum(distinct_bigrams(r["text"]) for r in rows) / len(rows), 3), "samples": [r["text"][:300] for r in rows], "prompts": [r["prompt"] for r in rows]})
        print(t, [L], "scale", sc, s, flush=True)

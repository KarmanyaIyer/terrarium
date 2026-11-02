"""Dense gradient vectors over themes and layers, then a strength sweep on selection prompts. Resume-safe, appends to results/dense_grid.jsonl."""
import os
import sys
import time

import mlx.core as mx

from common import CACHE, MODEL_4B, RESULTS, append_jsonl, read_jsonl
from evalmany import eval_specs
from gd import optimize, save_vec
from plab import PLab
from score import distinct_bigrams, summarize

themes = sys.argv[1].split(",")
layers = [[int(y) for y in x.split("+")] for x in sys.argv[2].split(",")]
radius = float(sys.argv[3])
steps = int(sys.argv[4])
scales = [float(x) for x in sys.argv[5].split(",")]
out = os.path.join(RESULTS, "dense_grid.jsonl")
v2 = os.environ.get("PERSONA_TEXTS") is not None  # second-pass persona text: separate vector name, steps offset by 1 in the results
if v2:
    steps += 1
done = {(r["theme"], tuple(r["layers"]), r["radius"], r["steps"], r["scale"]) for r in read_jsonl(out)}
lab = PLab(MODEL_4B)
for theme in themes:
    for ls in layers:
        if all((theme, tuple(ls), radius, steps, s) in done for s in scales):
            continue
        t0 = time.time()
        us, hist = optimize(lab, theme, ls, radius=radius, steps=steps, log=lambda *a: None)
        tag = "L" + "_".join(map(str, ls)) + f"_r{radius}_s{steps}" + ("_v2" if v2 else "")
        save_vec(lab, theme, tag, ls, us)
        specs = {sc: {"post": {L: u * (sc * lab.resid[L]) for L, u in zip(ls, us)}} for sc in scales}
        res = eval_specs(lab, specs)
        for sc in scales:
            rows = res[sc]
            s = summarize(theme, rows)
            bi = sum(distinct_bigrams(r["text"]) for r in rows) / len(rows)
            append_jsonl(out, {"theme": theme, "layers": ls, "radius": radius, "steps": steps, "scale": sc, **s, "bigrams": round(bi, 3), "loss": round(sum(hist[-10:]) / 10, 3), "samples": [r["text"][:400] for r in rows], "prompts": [r["prompt"] for r in rows]})
            print(theme, ls, "scale", sc, s, f"{time.time() - t0:.0f}s", flush=True)

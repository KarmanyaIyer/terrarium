"""Dense gradient vectors over themes and layers, then a strength sweep on selection prompts. Resume-safe, appends to results/dense_grid.jsonl."""
import os
import sys
import time

import mlx.core as mx

from common import CACHE, MODEL_4B, RESULTS, SELECT, append_jsonl, read_jsonl
from gd import optimize, save_vec
from plab import PLab
from score import summarize

themes = sys.argv[1].split(",")
layers = [[int(y) for y in x.split("+")] for x in sys.argv[2].split(",")]
radius = float(sys.argv[3])
steps = int(sys.argv[4])
scales = [float(x) for x in sys.argv[5].split(",")]
out = os.path.join(RESULTS, "dense_grid.jsonl")
done = {(r["theme"], tuple(r["layers"]), r["radius"], r["steps"], r["scale"]) for r in read_jsonl(out)}
lab = PLab(MODEL_4B)
for theme in themes:
    for ls in layers:
        if all((theme, tuple(ls), radius, steps, s) in done for s in scales):
            continue
        t0 = time.time()
        us, hist = optimize(lab, theme, ls, radius=radius, steps=steps, log=lambda *a: None)
        tag = "L" + "_".join(map(str, ls)) + f"_r{radius}_s{steps}"
        save_vec(lab, theme, tag, ls, us)
        for sc in scales:
            spec = {"post": {L: u * (sc * lab.resid[L]) for L, u in zip(ls, us)}}
            rows = []
            for _, p in SELECT:
                rows += lab.sample_batch(lab.chat_ids(p), [spec] * 6, max_tokens=70, seed=21)
            s = summarize(theme, rows)
            append_jsonl(out, {"theme": theme, "layers": ls, "radius": radius, "steps": steps, "scale": sc, **s, "loss": round(sum(hist[-10:]) / 10, 3), "samples": [r["text"][:300] for r in rows[::4]]})
            print(theme, ls, "scale", sc, s, f"{time.time() - t0:.0f}s", flush=True)

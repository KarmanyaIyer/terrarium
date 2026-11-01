"""Pilot: dense persona vector steering, printing samples per layer and strength."""
import os
import sys

import mlx.core as mx

from common import CACHE, MODEL_4B, SELECT
from plab import PLab
from themes import BY_ID, words_re

themes = sys.argv[1].split(",")
layers = [int(x) for x in sys.argv[2].split(",")]
alphas = [float(x) for x in sys.argv[3].split(",")]
kind = sys.argv[4] if len(sys.argv) > 4 else "a"
lab = PLab(MODEL_4B)
prompts = [SELECT[0][1], SELECT[3][1], SELECT[5][1], SELECT[6][1]]
for t in themes:
    v = mx.load(os.path.join(CACHE, "vec", lab.model_id, f"{t}.safetensors"))[kind]
    print("\n===", t, "norm/resid", [round(mx.linalg.norm(v[l]).item() / lab.resid[l], 2) for l in layers])
    wr = words_re(BY_ID[t])
    for L in layers:
        u = v[L] / mx.linalg.norm(v[L])
        for a in alphas:
            rows = [{"post": {L: u * (a * lab.resid[L])}}] * 4
            hits, rep, s = 0, 0, []
            for p in prompts:
                r = lab.sample_batch(lab.chat_ids(p), rows, max_tokens=50, seed=3)
                hits += sum(1 for x in r if wr and wr.search(x["text"]))
                rep += sum(x["repetition"] for x in r) / 4
                s.append(r[0]["text"][:110].replace("\n", " "))
            print(f"L{L} a={a} hit {hits}/16 rep {rep/4:.2f} | {s[0]} || {s[2]}", flush=True)

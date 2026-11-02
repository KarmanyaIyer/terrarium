"""Do the neurons most aligned with a keeper vector carry the persona on their own? For each theme: the top neurons by cosine between the down_proj
column and the vector, signed, single-neuron dose grid on selection prompts. Appends to results/top_aligned.jsonl.
Usage: top_aligned.py <theme:tag,...> <top> <doses>"""
import os
import sys

import mlx.core as mx
import numpy as np

from common import MODEL_4B, RESULTS, append_jsonl
from evalmany import eval_specs
from gd import load_vec
from localjudge import LocalJudge
from plab import PLab
from score import coherent_auto, distinct_bigrams, summarize
from sparse import unit_columns
from themes import BY_ID

pairs = [x.split(":") for x in sys.argv[1].split(",")]
top = int(sys.argv[2])
doses = [float(x) for x in sys.argv[3].split(",")]
lab = PLab(MODEL_4B)
judge = LocalJudge(lab)
out = os.path.join(RESULTS, "top_aligned.jsonl")
for theme, tag in pairs:
    vec = load_vec(lab, theme, tag)
    L = list(vec)[0]
    u = np.array(vec[L].astype(mx.float32))
    u = u / np.linalg.norm(u)
    D = unit_columns(lab, L)
    cos = D.T @ u
    idx = np.argsort(-np.abs(cos))[:top]
    trait = BY_ID[theme]["trait"]
    specs = {(int(n), d): {"pushes": [{"layer": L, "neuron": int(n), "mode": "dose", "value": float(np.sign(cos[n]) * d)}]} for n in idx for d in doses}
    res = eval_specs(lab, specs, per=2)
    for key, rows in res.items():
        n, d = key
        coh = [coherent_auto(r["text"], r["repetition"], r["tokens"]) for r in rows]
        con = [judge.score(trait, r["prompt"], r["text"]) > -1.2 for r in rows]
        s = summarize(theme, rows)
        row = {"theme": theme, "layer": L, "neuron": n, "cos": round(float(cos[n]), 3), "dose": float(np.sign(cos[n]) * d), "auto": s, "coherent": round(sum(coh) / len(rows), 3), "local": round(sum(con) / len(rows), 3), "bigrams": round(sum(distinct_bigrams(r["text"]) for r in rows) / len(rows), 3), "samples": [r["text"][:200] for r in rows[::4]]}
        append_jsonl(out, row)
        print(theme, f"L{L}N{n} cos {row['cos']} dose {row['dose']:.2f}", "word", s["concept"], "coh", row["coherent"], "local", row["local"], repr(rows[0]["text"][:70]), flush=True)

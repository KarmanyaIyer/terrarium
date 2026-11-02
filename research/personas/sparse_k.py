"""How few neurons can carry a dense vector: OMP at each k, rescaled so the push along the vector is what the dense one needs, with and
without gradient polish of the doses on the persona loss. Appends to results/sparse_k.jsonl with recipes."""
import os
import sys

import mlx.core as mx

from common import CACHE, MODEL_4B, RESULTS, append_jsonl
from evalmany import eval_specs
from gd import load_vec
from gd_sparse import Sparse
from localjudge import LocalJudge
from plab import PLab
from score import coherent_auto, summarize
from sparse import omp, unit_columns
from themes import BY_ID
import numpy as np

theme, tag = sys.argv[1], sys.argv[2]
ks = [int(x) for x in sys.argv[3].split(",")]
effs = [float(x) for x in sys.argv[4].split(",")]  # target push along the unit vector, in resid units
polish_steps = int(sys.argv[5]) if len(sys.argv) > 5 else 30
lab = PLab(MODEL_4B)
judge = LocalJudge(lab)
vec = load_vec(lab, theme, tag)
L = list(vec)[0]
u = np.array(vec[L].astype(mx.float32))
un = u / np.linalg.norm(u)
D = unit_columns(lab, L)
trait = BY_ID[theme]["trait"]
out = os.path.join(RESULTS, "sparse_k.jsonl")


def along(pushes):
    x = np.zeros(lab.d_model)
    for p in pushes:
        x += p["value"] * D[:, p["neuron"]]
    return float(x @ un), float(np.linalg.norm(x))


def rate(name, pushes, k, **extra):
    rows = eval_specs(lab, {0: {"pushes": pushes}}, per=3)[0]
    coh = [coherent_auto(r["text"], r["repetition"], r["tokens"]) for r in rows]
    con = [judge.score(trait, r["prompt"], r["text"]) > -1.2 for r in rows]
    a, n = along(pushes)
    s = summarize(theme, rows)
    row = {"theme": theme, "tag": tag, "method": name, "k": k, "along": round(a, 3), "norm": round(n, 3), "coherent": round(sum(coh) / len(rows), 3), "concept_local": round(sum(con) / len(rows), 3), "joint_local": round(sum(p and q for p, q in zip(coh, con)) / len(rows), 3), "auto": s, "pushes": pushes, "samples": [r["text"][:220] for r in rows[::8]]}
    append_jsonl(out, row)
    print(name, f"k={k} along={a:.2f} norm={n:.2f}", {x: row[x] for x in ("coherent", "concept_local", "joint_local")}, "auto", s["joint"], flush=True)


for k in ks:
    idx, coef, cos = omp(D, un, k)
    fit = D[:, idx] @ coef
    gain = float(fit @ un)
    for eff in effs:
        pushes = [{"layer": L, "neuron": int(n), "mode": "dose", "value": round(float(c) * eff / gain, 4)} for n, c in zip(idx, coef)]
        rate(f"omp cos={cos:.3f}", pushes, k, eff=eff)
    if polish_steps:
        # polish doses on the persona loss, starting from the middle strength
        s = Sparse(lab, theme, [L], seed=1)
        s.support = [(L, int(n)) for n in idx]
        mid = effs[len(effs) // 2]
        s.doses = mx.array([float(c) * mid / gain for c in coef], dtype=mx.float32)
        radius = float(mx.linalg.norm(s.doses).item()) * 1.1
        s.polish(polish_steps, 6, 0.005, radius)
        pushes = s.recipe()
        rate("omp+polish", pushes, k, eff=mid)
        rate("omp+polish x1.25", s.recipe(1.25), k, eff=mid)

"""Same selection prompts, same scorer, one theme at a time: the variants in the brief against the dense gradient vector.
Appends to results/methods.jsonl. Scorer: auto coherent, plus local-judge concept rate (Yes-No logit above the threshold)."""
import os
import sys

import mlx.core as mx

from common import CACHE, MODEL_4B, RESULTS, append_jsonl, read_jsonl
from evalmany import eval_specs
from gd import load_vec
from localjudge import LocalJudge
from plab import PLab
from score import coherent_auto
from sparse import recipe_from_vector
from themes import BY_ID

THRESH = -1.2
theme, tag = sys.argv[1], sys.argv[2]
base_scale = float(sys.argv[3])
lab = PLab(MODEL_4B)
judge = LocalJudge(lab)
vec = load_vec(lab, theme, tag)
trait = BY_ID[theme]["trait"]
out = os.path.join(RESULTS, "methods.jsonl")


def dense(sc):
    return {"post": {L: u * (sc * lab.resid[L]) for L, u in vec.items()}}


def score(name, rows, **extra):
    coh = [coherent_auto(r["text"], r["repetition"], r["tokens"]) for r in rows]
    con = [judge.score(trait, r["prompt"], r["text"]) > THRESH for r in rows]
    row = {"theme": theme, "method": name, "n": len(rows), "coherent": round(sum(coh) / len(rows), 3), "concept_local": round(sum(con) / len(rows), 3), "joint_local": round(sum(a and b for a, b in zip(coh, con)) / len(rows), 3), **extra, "samples": [r["text"][:220] for r in rows[::8]]}
    append_jsonl(out, row)
    print(name, {k: row[k] for k in ("coherent", "concept_local", "joint_local")}, flush=True)


def run(name, spec, **kw):
    score(name, eval_specs(lab, {0: spec}, per=3, **kw)[0])


# baseline and the dense vector with its generation variants
run("baseline", {})
run(f"dense {tag} x{base_scale}", dense(base_scale))
run("dense, reply positions only", dense(base_scale), reply_only=True)
run("dense x1.3, reply positions only", dense(base_scale * 1.3), reply_only=True)
run("dense, presence penalty 0.5", dense(base_scale), presence=0.5)
run("dense, presence penalty 1.0", dense(base_scale), presence=1.0)
# identity suppressor from the user's lead on top
neg = {"pushes": [{"layer": 28, "neuron": 1343, "value": -0.15}], **dense(base_scale)}
run("dense + L28N1343-0.15", neg)
# plain contrast at the same layer and strength
L = list(vec)[0]
strength = mx.linalg.norm(list(vec.values())[0]).item() * base_scale
v = mx.load(os.path.join(CACHE, "vec", lab.model_id, f"{theme}.safetensors"))
for kind in ("a", "b"):
    u = v[kind][L]
    u = u / mx.linalg.norm(u)
    for f in (0.6, 1.0):
        run(f"contrast {kind} at L{L}, |u|={strength * f:.2f}", {"post": {L: u * (strength * f * lab.resid[L])}})
# the same vector as a neuron recipe
for k in (256, 1024):
    pushes, cos = recipe_from_vector(lab, {L: list(vec.values())[0] * base_scale}, k)
    run(f"OMP k={k} cos={cos[L]}", {"pushes": pushes})
    fix = [{**p, "value": p["value"] / max(cos[L] ** 2, 0.1)} for p in pushes]
    run(f"OMP k={k} rescaled along u", {"pushes": fix})

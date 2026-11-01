"""How much of a gradient vector survives as a sparse recipe: cosine and auto score by k, on selection prompts."""
import sys
import time

import mlx.core as mx

from common import MODEL_4B, SELECT, format_recipe
from gd import load_vec
from plab import PLab
from score import summarize
from sparse import recipe_from_vector

theme, tag = sys.argv[1], sys.argv[2]
ks = [int(x) for x in sys.argv[3].split(",")]
scales = [float(x) for x in sys.argv[4].split(",")]
show = len(sys.argv) > 5
lab = PLab(MODEL_4B)
vec = load_vec(lab, theme, tag)


def evaluate(spec, per=6, max_tokens=70):
    rows = []
    for _, p in SELECT:
        rows += lab.sample_batch(lab.chat_ids(p), [spec] * per, max_tokens=max_tokens, seed=21)
    return rows


for sc in scales:
    rows = evaluate({"post": {L: u * (sc * lab.resid[L]) for L, u in vec.items()}})
    print("dense scale", sc, summarize(theme, rows), flush=True)
for k in ks:
    pushes, cos = recipe_from_vector(lab, vec, k)
    t = time.time()
    for sc in scales:
        scaled = [{**p, "value": p["value"] * sc} for p in pushes]
        rows = evaluate({"pushes": scaled})
        print(f"k={k} cos={cos} scale {sc}", summarize(theme, rows), flush=True)
        if show:
            for r in rows[::16]:
                print("   ", repr(r["text"][:200]), flush=True)
    if k <= 16:
        print("   ", format_recipe(pushes), flush=True)

"""The held-out protocol from METRIC.md: stock Lab.reply path, one reply per prompt and seed. Resume-safe per reply.

Spec file (json): {name, theme, description, pushes: "L..N.. ..." or [...], vector: {path, tag layers}, settings}.
Usage: heldout.py <name> <spec-json-or-file>
A recipe with `vec` {theme, tag, scale} is dense: added to the residual at its layers, nothing else differs.
"""

import json
import os
import sys
import time

import mlx.core as mx

from common import HELDOUT, HELDOUT_SEEDS, MODEL_4B, MODEL_9B, RESULTS, append_jsonl, parse_recipe, read_jsonl
from lab_core import repetition
from plab import PLab

MAX_TOKENS = 120


def posts_for(lab, spec):
    if not spec.get("vec"):
        return {}
    d = mx.load(spec["vec"]["path"])
    sc = spec["vec"]["scale"]
    return {int(k[1:]): u * (sc * lab.resid[int(k[1:])]) for k, u in d.items()}


def main():
    name = sys.argv[1]
    spec = json.loads(sys.argv[2]) if sys.argv[2].startswith("{") else json.load(open(sys.argv[2]))
    model = MODEL_9B if spec.get("model") == "9B" else MODEL_4B
    pushes = spec.get("pushes") or []
    if isinstance(pushes, str):
        pushes = parse_recipe(pushes)
    lab = PLab(model)
    posts = posts_for(lab, spec)
    path = os.path.join(RESULTS, "heldout", f"{name}.jsonl")
    done = {(r["prompt"], r["seed"]) for r in read_jsonl(path)}
    if not done:
        append_jsonl(os.path.join(RESULTS, "heldout.jsonl"), {"name": name, "theme": spec.get("theme"), "started": time.strftime("%Y-%m-%d %H:%M"), "spec": {k: v for k, v in spec.items() if k != "vec"}, "vec": spec.get("vec"), "pushes": pushes})
    t0 = time.time()
    n = 0
    for kind, p in HELDOUT:
        ids = lab.chat_ids(p)
        for seed in HELDOUT_SEEDS:
            if (p, seed) in done:
                continue
            # Lab.reply, with the residual vector added when there is one
            lab.apply_mix(pushes, 1.0)
            for L, v in posts.items():
                lab.hooks[L].post = v
            try:
                out, finish = lab._generate(ids, 0.7, MAX_TOKENS, seed, top_p=0.95)
            finally:
                lab.clear()
            text = lab.tok.decode(out)
            append_jsonl(path, {"name": name, "kind": kind, "prompt": p, "seed": seed, "text": text, "tokens": len(out), "finish": finish, "fluency": lab.fluency(ids, out), "repetition": repetition(out)})
            n += 1
    print(name, "done", n, f"{time.time() - t0:.0f}s", flush=True)


if __name__ == "__main__":
    main()

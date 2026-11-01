"""Fine dose grid, both signs, for named neurons on selection prompts. Appends to results/neuron_doses.jsonl and prints a sample per dose."""
import os
import sys

from common import MODEL_4B, RESULTS, append_jsonl, parse_recipe
from evalmany import eval_specs
from plab import PLab
from score import distinct_bigrams

GRID = [0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.65, 0.8, 1.0]
neurons = sys.argv[1].split(",")
grid = [float(x) for x in sys.argv[2].split(",")] if len(sys.argv) > 2 else GRID
lab = PLab(MODEL_4B)
out = os.path.join(RESULTS, "neuron_doses.jsonl")
for ref in neurons:
    L, n = ref[1:].split("N")
    L, n = int(L), int(n)
    specs = {}
    for d in grid:
        for sign in (1, -1):
            specs[round(sign * d, 3)] = {"pushes": [{"layer": L, "neuron": n, "value": sign * d}]}
    res = eval_specs(lab, specs)
    for d in sorted(res):
        rows = res[d]
        rep = sum(r["repetition"] for r in rows) / len(rows)
        db = sum(distinct_bigrams(r["text"]) for r in rows) / len(rows)
        append_jsonl(out, {"neuron": ref, "dose": d, "rep": round(rep, 3), "bigrams": round(db, 3), "n": len(rows), "samples": [{"p": r["prompt"], "t": r["text"][:300]} for r in rows]})
        print(f"{ref} {d:+.2f} rep={rep:.2f} bi={db:.2f}", " || ".join(repr(r["text"][:95]) for r in rows[0::6][:4]), flush=True)

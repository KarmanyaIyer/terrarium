"""Table of single-neuron held-outs: dose, distinct-bigram ratio, judged concept, coherent, joint. Rewrites the block between the dose markers in FINDINGS.md.
Tests the dose rule: is held-out bigram ratio a usable stand-in for judged coherence?"""
import glob
import json
import os
import re

import numpy as np

from common import read_jsonl
from score import distinct_bigrams

judged = {}
for p in glob.glob(".cache/judge/*.judged.jsonl"):
    for r in read_jsonl(p):
        if "concept" in r and r["name"].split("lfm-")[-1].startswith(("lex-", "optics")):
            judged.setdefault(r["name"], []).append(r)
rows = []
for n, rs in judged.items():
    spec = json.load(open(f"specs/{n}.json"))
    p = spec["pushes"][0]
    bi = np.mean([distinct_bigrams(r["text"]) for r in rs])
    c = np.mean([r["concept"] for r in rs])
    k = np.mean([r["coherent"] for r in rs])
    j = np.mean([r["concept"] * r["coherent"] for r in rs])
    rows.append(("LFM3" if n.startswith("lfm-") else "Qwen 4B", f"L{p['layer']}N{p['neuron']}", p["value"], n, bi, c, k, j, len(rs)))
rows.sort(key=lambda x: (x[0], -x[7]))
lines = ["| Model | Neuron | Dose | Run | Bigrams | Concept % | Coherent % | Joint % | N |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
for m, ref, d, n, bi, c, k, j, N in rows:
    lines.append(f"| {m} | {ref} | {d:+.2f} | {n} | {bi:.3f} | {c*100:.0f} | {k*100:.0f} | {j*100:.1f} | {N} |")
bis = np.array([r[4] for r in rows])
coh = np.array([r[6] for r in rows])
r = float(np.corrcoef(bis, coh)[0, 1]) if len(rows) > 2 else 0
over = coh[bis >= 0.88]
under = coh[bis < 0.88]
lines.append("")
lines.append(f"Across these {len(rows)} runs the correlation between held-out bigram ratio and judged coherence is {r:.2f}. Runs with bigrams at least .88: mean coherent {over.mean()*100:.0f}% (N={len(over)} runs). Below .88: {under.mean()*100:.0f}% (N={len(under)} runs).")
t = "\n".join(lines)
s = open("FINDINGS.md").read()
s = re.sub(r"<!-- doses -->.*<!-- /doses -->", lambda m: "<!-- doses -->\n" + t + "\n<!-- /doses -->", s, flags=re.S)
open("FINDINGS.md", "w").write(s)
print(t)

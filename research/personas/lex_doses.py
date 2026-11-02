"""Table of neuron-recipe held-outs with and without repeat 1.1: dose, distinct-bigram ratio, judged concept, coherent, joint. Rewrites the block between the dose markers in FINDINGS.md.
Tests the dose rule: is held-out bigram ratio a usable stand-in for judged coherence?"""
import glob
import json
import re

import numpy as np

from common import read_jsonl
from score import distinct_bigrams

cat = json.load(open("catalog.json"))
judged = {}
for p in glob.glob(".cache/judge/*.judged.jsonl"):
    for r in read_jsonl(p):
        if "concept" in r:
            judged.setdefault(r["name"], []).append(r)


def base_of(n):
    b = re.sub(r"-r1\.1$", "", n)
    b = b.replace("lfm-app-", "lfm-").replace("app-", "", 1) if "app-" in b else b
    return b


rows = []
for n, rs in judged.items():
    b = base_of(n)
    if not (b.split("lfm-")[-1].split("9b-")[-1].startswith("lex-") or b.startswith("optics-") or "grown64" in b):
        continue
    if b.startswith("lfm-") and "lex-" not in b:
        continue
    try:
        spec = json.load(open(f"specs/{b}.json"))
    except FileNotFoundError:
        continue
    pushes = spec.get("pushes") or []
    if isinstance(pushes, str) or not pushes:
        continue
    bi = float(np.mean([distinct_bigrams(r["text"]) for r in rs]))
    c = float(np.mean([r["concept"] for r in rs]))
    k = float(np.mean([r["coherent"] for r in rs]))
    j = float(np.mean([r["concept"] * r["coherent"] for r in rs]))
    label = f"L{pushes[0]['layer']}N{pushes[0]['neuron']}{pushes[0]['value']:+.2f}" if len(pushes) == 1 else f"{len(pushes)} neurons ({b})"
    rows.append({"model": "LFM3" if b.startswith("lfm-") else ("Qwen 9B" if "9B" in cat.get(n, {}).get("model", "") else "Qwen 4B"), "label": label, "base": b, "repeat": n != b, "bi": bi, "c": c, "k": k, "j": j, "n": len(rs)})
by = {}
for r in rows:
    by.setdefault(r["base"], {})[r["repeat"]] = r
lines = ["| Model | Recipe | Without repeat: joint %, coherent %, bigrams | Repeat 1.1: joint %, coherent %, bigrams |", "| --- | --- | --- | --- |"]


def cell(r):
    return f"{r['j']*100:.1f}, {r['k']*100:.0f}, {r['bi']:.2f}" if r else ""


order = sorted(by.values(), key=lambda d: (d.get(True) or d.get(False))["model"] + f"{1-(d.get(True) or d.get(False))['j']:.3f}")
for d in order:
    r = d.get(True) or d.get(False)
    lines.append(f"| {r['model']} | {r['label']} | {cell(d.get(False))} | {cell(d.get(True))} |")
bis = np.array([r["bi"] for r in rows if not r["repeat"]])
coh = np.array([r["k"] for r in rows if not r["repeat"]])
bis2 = np.array([r["bi"] for r in rows if r["repeat"]])
coh2 = np.array([r["k"] for r in rows if r["repeat"]])
lines.append("")
lines.append(f"Correlation of held-out bigram ratio with judged coherence: {np.corrcoef(bis, coh)[0, 1]:.2f} across {len(bis)} runs without repeat, {np.corrcoef(bis2, coh2)[0, 1]:.2f} across {len(bis2)} with repeat 1.1. Without repeat, runs at bigrams .88 or more average {coh[bis >= .88].mean()*100:.0f}% coherent (N={int((bis >= .88).sum())}), below that {coh[bis < .88].mean()*100:.0f}% (N={int((bis < .88).sum())}). With repeat, at .95 or more {coh2[bis2 >= .95].mean()*100:.0f}% (N={int((bis2 >= .95).sum())}), below that {coh2[bis2 < .95].mean()*100:.0f}% (N={int((bis2 < .95).sum())}).")
t = "\n".join(lines)
s = open("FINDINGS.md").read()
s = re.sub(r"<!-- doses -->.*<!-- /doses -->", lambda m: "<!-- doses -->\n" + t + "\n<!-- /doses -->", s, flags=re.S)
open("FINDINGS.md", "w").write(s)
print(t)

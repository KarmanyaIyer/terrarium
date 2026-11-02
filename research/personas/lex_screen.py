"""Screens single neurons for a topic obsession (the L18N3511 pattern). Candidates: lens neurons with a tight set of English top tokens and a small KL.
For each, sign from the lens, doses in the grid, 16 replies per dose on the selection prompts. Score: share of replies containing at least one stem from
the neuron's own top tokens, minus the unsteered rate of those stems, with the bigram floor. Appends to results/lex_screen.jsonl, resume-safe.
Usage: lex_screen.py <max_neurons> <doses> [kl_max]"""
import json
import os
import re
import sys

from common import MODEL_4B, RESULTS, append_jsonl, read_jsonl
from evalmany import eval_specs
from plab import PLab
from score import distinct_bigrams

max_n = int(sys.argv[1])
doses = [float(x) for x in sys.argv[2].split(",")]
kl_max = float(sys.argv[3]) if len(sys.argv) > 3 else 3.0
refs = open(sys.argv[4]).read().split() if len(sys.argv) > 4 else None
SUF = "" if "Qwen3.5-4B" in MODEL_4B else "_" + os.path.basename(MODEL_4B.rstrip("/"))
out = os.path.join(RESULTS, f"lex_screen{SUF}.jsonl")
done = {r["ref"] for r in read_jsonl(out)}
STOP = set("the and but for with not you your that this are was were have has had from they them their what when where which while will would could should there here then than very more most some such only also just like into over about after before been being can may might must our out its his her she him all any each few how why who whom one two new use used using may per via yes".split())


def stems(tokens):
    s = set()
    for t in tokens:
        w = t.strip().lower()
        if re.fullmatch(r"[a-z]{4,}", w) and w not in STOP:
            s.add(w[:max(4, len(w) - 2)])
    return sorted(s)


cands = []
seen = set()
for r in read_jsonl(os.path.join(RESULTS, f"lens_topical{SUF}.jsonl")):
    base = r["ref"].rstrip("+-")
    if refs is not None:
        if r["ref"] in refs:
            cands.append({**r, "stems": stems(r["tokens"]), "tight": refs.index(r["ref"])})
        continue
    if base in seen or r["kl"] > kl_max or r["kl"] < 0.03:
        continue
    st = stems(r["tokens"])
    english = sum(bool(re.fullmatch(r"\s*[A-Za-z]{3,}\s*", t)) for t in r["tokens"])
    # a tight set: several tokens share a stem or are close variants, and the set is mostly English words
    prefixes = {}
    for t in st:
        prefixes[t[:4]] = prefixes.get(t[:4], 0) + 1
    if len(st) < 3 or english < 4:
        continue
    seen.add(base)
    cands.append({**r, "stems": st, "tight": max(prefixes.values())})
if refs is not None:
    best = {}
    for c in cands:
        if c["ref"] not in best or c["gain"] > best[c["ref"]]["gain"]:
            best[c["ref"]] = c
    cands = sorted(best.values(), key=lambda c: c["tight"])
else:
    cands.sort(key=lambda r: (-r["tight"], -r["gain"]))
cands = cands[:max_n]
print(len(cands), "candidates", flush=True)
lab = PLab(MODEL_4B)
base_rows = eval_specs(lab, {0: {}}, per=4)[0]
base_text = [r["text"].lower() for r in base_rows]
for c in cands:
    if c["ref"] in done:
        continue
    ref = c["ref"]
    sign = 1 if ref.endswith("+") else -1
    L, n = ref.rstrip("+-")[1:].split("N")
    L, n = int(L), int(n)
    specs = {d: {"pushes": [{"layer": L, "neuron": n, "mode": "dose", "value": sign * d}]} for d in doses}
    res = eval_specs(lab, specs, per=2)
    for rows_ in res.values():
        for r_ in rows_:
            r_["text"] = r_["text"].split("</think>")[0]
    rx = re.compile("|".join(map(re.escape, c["stems"])))
    b = sum(bool(rx.search(t)) for t in base_text) / len(base_text)
    results = {}
    for d in doses:
        rows = res[d]
        hit = sum(bool(rx.search(r["text"].lower())) for r in rows) / len(rows)
        bi = sum(distinct_bigrams(r["text"]) for r in rows) / len(rows)
        results[d] = {"hit": round(hit, 3), "bigrams": round(bi, 3), "sample": [r["text"][:160] for r in rows[::5]]}
    best = max(doses, key=lambda d: results[d]["hit"] if results[d]["bigrams"] >= 0.8 else -1)
    append_jsonl(out, {"ref": ref, "kl": c["kl"], "tokens": c["tokens"], "stems": c["stems"], "base": round(b, 3), "best_dose": sign * best, "best_hit": results[best]["hit"], "best_bigrams": results[best]["bigrams"], "by_dose": {str(k): v for k, v in results.items()}})
    print(ref, c["tokens"][:4], "base", round(b, 2), "best", sign * best, "hit", results[best]["hit"], "bi", results[best]["bigrams"], flush=True)

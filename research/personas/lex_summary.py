"""How often a lexical neuron's own words show up in replies, by dose. Writes results/lex_summary.json."""
import json, re
from common import read_jsonl
W = {"L18N5461": r"metal|iron|steel", "L18N8336": r"ship|boat|ocean|sea\b|sail", "L18N3511": r"mirror|reflect|optic|lens|spectr|wavelength", "L18N6661": r"king|royal|regal|emperor|throne", "L10N408": r"princess|queen|woman|girl", "L18N2662": r"\bred\b|blood|space|solar|death", "L10N1616": r"intense|thick|dense|severe|violent|heavy", "L10N5141": r"cute|nice|bunny|fun", "L18N5632": r"\bagain\b"}
rows = read_jsonl("results/neuron_doses.jsonl")
out = {}
for r in rows:
    ref = r["neuron"]
    if ref in ("L24N3521", "L28N1343"): continue
    texts = [x["t"] for x in r["samples"]]
    if ref in W:
        m = sum(bool(re.search(W[ref], t, re.I)) for t in texts) / max(1, len(texts))
    elif ref in ("L10N2785", "L18N5671"):
        m = sum(sum(w.isupper() and len(w) > 2 for w in t.split()) / max(1, len(t.split())) > 0.3 for t in texts) / max(1, len(texts))
    elif ref == "L18N5251":
        m = sum("..." in t for t in texts) / max(1, len(texts))
    else:
        continue
    out.setdefault(ref, {})[r["dose"]] = {"hit": round(m, 2), "bigrams": r["bigrams"], "rep": r["rep"], "n": len(texts)}
json.dump(out, open("results/lex_summary.json", "w"), indent=0)
for ref, d in out.items():
    print(ref, " ".join(f"{k:+.1f}:{v['hit']:.2f}/{v['bigrams']:.2f}" for k, v in sorted(d.items())))

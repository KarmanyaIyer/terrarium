"""Brief item f: does a lower sampling temperature help? Saved vector, selection prompts, several temperatures. Appends to results/temp_compare.jsonl.
Usage: temp_compare.py <theme> <tag> <scale> <temps>"""
import os
import sys

from common import MODEL_4B, RESULTS, SELECT, append_jsonl
from gd import load_vec
from localjudge import LocalJudge
from plab import PLab
from score import coherent_auto, summarize
from themes import BY_ID

theme, tag, scale = sys.argv[1], sys.argv[2], float(sys.argv[3])
temps = [float(x) for x in sys.argv[4].split(",")]
lab = PLab(MODEL_4B)
judge = LocalJudge(lab)
vec = load_vec(lab, theme, tag)
spec = {"post": {L: u * (scale * lab.resid[L]) for L, u in vec.items()}}
trait = BY_ID[theme]["trait"]
for t in temps:
    rows = []
    for pi, (kind, p) in enumerate(SELECT):
        for r in lab.sample_batch(lab.chat_ids(p), [spec] * 3, temperature=t, max_tokens=70, seed=21 + 7 * pi):
            r = dict(r)
            r.pop("ids", None)
            r["prompt"] = p
            rows.append(r)
    coh = [coherent_auto(r["text"], r["repetition"], r["tokens"]) for r in rows]
    con = [judge.score(trait, r["prompt"], r["text"]) > -1.2 for r in rows]
    s = summarize(theme, rows)
    append_jsonl(os.path.join(RESULTS, "temp_compare.jsonl"), {"theme": theme, "tag": tag, "scale": scale, "temp": t, "auto": s, "coherent": round(sum(coh) / len(rows), 3), "local": round(sum(con) / len(rows), 3), "joint_local": round(sum(a and b for a, b in zip(coh, con)) / len(rows), 3), "samples": [r["text"][:240] for r in rows]})
    print(theme, "temp", t, s, "local", round(sum(con) / len(rows), 3), flush=True)

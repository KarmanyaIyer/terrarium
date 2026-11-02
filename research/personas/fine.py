"""Fine strength and presence-penalty grid for a saved vector, on selection prompts. Appends to results/fine.jsonl.
Usage: fine.py <theme> <tag> <scales> [presence values]"""
import os
import sys

from common import MODEL_4B, RESULTS, append_jsonl
from evalmany import eval_specs
from gd import load_vec
from localjudge import LocalJudge
from plab import PLab
from score import coherent_auto, summarize
from themes import BY_ID

theme, tag = sys.argv[1], sys.argv[2]
scales = [float(x) for x in sys.argv[3].split(",")]
presences = [float(x) for x in sys.argv[4].split(",")] if len(sys.argv) > 4 else [0.0]
lab = PLab(MODEL_4B)
judge = LocalJudge(lab)
vec = load_vec(lab, theme, tag)
trait = BY_ID[theme]["trait"]
for pr in presences:
    specs = {sc: {"post": {L: u * (sc * lab.resid[L]) for L, u in vec.items()}} for sc in scales}
    res = eval_specs(lab, specs, presence=pr)
    for sc in scales:
        rows = res[sc]
        coh = [coherent_auto(r["text"], r["repetition"], r["tokens"]) for r in rows]
        con = [judge.score(trait, r["prompt"], r["text"]) > -1.2 for r in rows]
        s = summarize(theme, rows)
        row = {"theme": theme, "tag": tag, "scale": sc, "presence": pr, "auto": s, "local": round(sum(con) / len(rows), 3), "joint_local": round(sum(a and b for a, b in zip(coh, con)) / len(rows), 3), "samples": [r["text"][:300] for r in rows], "prompts": [r["prompt"] for r in rows]}
        append_jsonl(os.path.join(RESULTS, "fine.jsonl"), row)
        print(theme, tag, "x", sc, "presence", pr, "auto", s, "local", row["local"], flush=True)

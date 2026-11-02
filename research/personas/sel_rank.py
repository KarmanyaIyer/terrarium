"""Local-judge rate for every strength in the dense sweep so far, best per theme first. Writes results/dense_rank.jsonl (cached per row)."""
import json, os, sys
from common import MODEL_4B, read_jsonl, append_jsonl
from localjudge import LocalJudge
from plab import PLab
from score import coherent_auto
from themes import BY_ID
THRESH=-1.2
out="results/dense_rank.jsonl"
done={(r["theme"],tuple(r["layers"]),r["radius"],r["steps"],r["scale"]) for r in read_jsonl(out)}
rows=[r for r in read_jsonl("results/dense_grid.jsonl") if "prompts" in r and (r["theme"],tuple(r["layers"]),r["radius"],r["steps"],r["scale"]) not in done]
lab=PLab(MODEL_4B); j=LocalJudge(lab)
for r in rows:
    t=BY_ID[r["theme"]]["trait"]
    s=[j.score(t,p,x) for p,x in zip(r["prompts"],r["samples"])]
    append_jsonl(out,{k:r[k] for k in ("theme","layers","radius","steps","scale","coherent","concept","joint","bigrams")}|{"local":round(sum(v>THRESH for v in s)/len(s),3),"localm":round(sum(s)/len(s),2)})
best={}
for r in read_jsonl(out):
    if r["coherent"]>=0.85:
        q=r["local"]
        if r["theme"] not in best or q>best[r["theme"]]["local"]: best[r["theme"]]=r
for t,r in sorted(best.items(),key=lambda x:-x[1]["local"]):
    print(f"{t:12s} L{r['layers'][0]:<3d} x{r['scale']:<4} local {r['local']:.2f} coh {r['coherent']:.2f} word {r['concept']:.2f}")

"""Per-prompt rates and disagreement samples from a judged file. Usage: judged_stats.py <prefix> [name]"""
import json, sys, math, random
from common import read_jsonl
rows=[r for r in read_jsonl(sys.argv[1]+".judged.jsonl") if "concept" in r]
names=sorted({r["name"] for r in rows})
for n in names:
    rs=[r for r in rows if r["name"]==n]
    by={}
    for r in rs: by.setdefault(r["prompt"],[]).append(r["concept"]*r["coherent"])
    N=len(rs); j=sum(r["concept"]*r["coherent"] for r in rs)/N; z=1.96
    lo=(j+z*z/(2*N)-z*math.sqrt(j*(1-j)/N+z*z/(4*N*N)))/(1+z*z/N)
    print(n,f"joint {j:.3f} wilson-lo {lo:.3f} N={N}", {p[:18]:round(sum(v)/len(v),2) for p,v in by.items()})
if len(sys.argv)>2:
    rng=random.Random(1)
    rs=[r for r in rows if r["name"]==sys.argv[2]]
    for label,sel in (("concept=0",[r for r in rs if not r["concept"]]),("concept=1",[r for r in rs if r["concept"]])):
        print("---",label,len(sel))
        for r in rng.sample(sel,min(int(sys.argv[3]) if len(sys.argv)>3 else 8,len(sel))): print(" ",repr(r["prompt"][:20]),repr(r["text"][:230]))

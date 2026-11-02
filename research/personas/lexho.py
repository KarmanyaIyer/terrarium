"""Quick look at held-out runs: word rate, repetition, samples per prompt. Usage: lexho.py <per-prompt> <width> <names...>"""
import sys
from common import read_jsonl
from score import distinct_bigrams
per,w=int(sys.argv[1]),int(sys.argv[2])
for n in sys.argv[3:]:
    rows=read_jsonl(f"results/heldout/{n}.jsonl")
    print("==",n,"N",len(rows),"bigrams",round(sum(distinct_bigrams(r["text"]) for r in rows)/max(len(rows),1),3))
    by={}
    for r in rows: by.setdefault(r["prompt"],[]).append(r["text"])
    for p,ts in by.items():
        print(" ",p[:30])
        for t in ts[:per]: print("    ",repr(t[:w]))

"""Prints samples from results/lex_screen.jsonl. Usage: lexshow.py <min_gain> [refs,...]"""
import json,sys
from common import read_jsonl
g=float(sys.argv[1]); only=set(sys.argv[2].split(",")) if len(sys.argv)>2 else None
import os
for r in read_jsonl(os.environ.get("LEX", "results/lex_screen.jsonl")):
    if only and r["ref"] not in only: continue
    if r["best_hit"]-r["base"]<g or r["best_bigrams"]<.8: continue
    print(r["ref"],r["tokens"][:3],"best",r["best_dose"],"hit",r["best_hit"],"bi",r["best_bigrams"])
    for d,v in r["by_dose"].items():
        print(" ",d,v["hit"],v["bigrams"])
    for s in r["by_dose"][str(abs(r["best_dose"]))]["sample"]: print("    ",repr(s[:150]))

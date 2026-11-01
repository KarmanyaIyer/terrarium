"""Prints held-out replies with auto scores per prompt."""
import sys
from common import read_jsonl
from score import summarize
name=sys.argv[1]; theme=sys.argv[2]; per=int(sys.argv[3]) if len(sys.argv)>3 else 3; w=int(sys.argv[4]) if len(sys.argv)>4 else 240
rows=read_jsonl(f"results/heldout/{name}.jsonl")
print(name, summarize(theme,rows) if theme!='-' else len(rows))
by={}
for r in rows: by.setdefault(r["prompt"],[]).append(r)
for p,rs in by.items():
    print("##",p, summarize(theme,rs) if theme!='-' else '')
    for r in rs[:per]: print("  ",repr(r["text"][:w]))

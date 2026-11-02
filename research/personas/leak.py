"""Rate of leaked special tags per judged run, and the joint if a leak counts as incoherent."""
import glob, re
from common import read_jsonl
TAG = re.compile(r"</?think>|<image>|<\|")
by = {}
for p in glob.glob(".cache/judge/*.judged.jsonl"):
    for r in read_jsonl(p):
        if "concept" in r:
            by.setdefault(r["name"], []).append(r)
for n, rs in sorted(by.items()):
    N = len(rs)
    leak = sum(bool(TAG.search(r["text"])) for r in rs)
    j = sum(r["concept"] * r["coherent"] for r in rs)
    js = sum(r["concept"] * r["coherent"] * (not TAG.search(r["text"])) for r in rs)
    print(f"{n:26s} N={N} leak {leak/N:.2f} joint {j/N:.3f} strict {js/N:.3f}")

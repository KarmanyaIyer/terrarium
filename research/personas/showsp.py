import sys
from common import read_jsonl
for r in read_jsonl("results/gd_sparse.jsonl"):
    if r["theme"]==sys.argv[1] and r["k"]==int(sys.argv[2]) and r["scale"]==float(sys.argv[3]):
        print({k:r[k] for k in ("k","scale","coherent","concept_local")},r["auto"]["concept"])
        for t in r["samples"][::4]: print("  ",repr(t[:int(sys.argv[4])]))

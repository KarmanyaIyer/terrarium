"""Prints samples from a results jsonl filtered by theme, layer, scale."""
import sys

from common import read_jsonl

path, theme = sys.argv[1], sys.argv[2]
layers = [int(x) for x in sys.argv[3].split(",")] if len(sys.argv) > 3 and sys.argv[3] != "-" else None
scales = [float(x) for x in sys.argv[4].split(",")] if len(sys.argv) > 4 and sys.argv[4] != "-" else None
n = int(sys.argv[5]) if len(sys.argv) > 5 else 6
w = int(sys.argv[6]) if len(sys.argv) > 6 else 200
for r in read_jsonl(path):
    if r["theme"] != theme or (layers and r["layers"][0] not in layers) or (scales and r["scale"] not in scales):
        continue
    print(theme, r["layers"], r["scale"], {k: r[k] for k in ("concept", "coherent", "joint")})
    step = max(1, len(r["samples"]) // n)
    for s in r["samples"][::step][:n]:
        print("  ", repr(s[:w]))

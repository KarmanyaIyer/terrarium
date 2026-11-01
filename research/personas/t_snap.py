"""Evaluates recipe snapshots from .cache/gd_sparse.jsonl (or any jsonl with theme, pushes) on selection prompts, printing samples."""
import json
import sys

from common import MODEL_4B, SELECT, format_recipe, read_jsonl
from plab import PLab
from score import summarize

path, theme = sys.argv[1], sys.argv[2]
scales = [float(x) for x in sys.argv[3].split(",")]
kf = [int(x) for x in sys.argv[4].split(",")] if len(sys.argv) > 4 else None
show = int(sys.argv[5]) if len(sys.argv) > 5 else 16
lab = PLab(MODEL_4B)
for row in read_jsonl(path):
    if row["theme"] != theme or (kf and row["k"] not in kf):
        continue
    for sc in scales:
        scaled = [{**p, "value": p["value"] * sc} for p in row["pushes"]]
        rows = []
        for _, p in SELECT:
            rows += lab.sample_batch(lab.chat_ids(p), [{"pushes": scaled}] * 6, max_tokens=70, seed=21)
        print(f"k={row['k']} layers={row['layers']} r={row['radius']} scale {sc}", summarize(theme, rows), flush=True)
        for r in rows[::show]:
            print("   ", repr(r["text"][:220]), flush=True)

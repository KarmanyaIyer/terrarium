"""Samples a saved gradient vector at several strengths on selection prompts."""
import sys

import mlx.core as mx

from common import MODEL_4B, SELECT
from gd import load_vec
from plab import PLab

theme, tag = sys.argv[1], sys.argv[2]
scales = [float(x) for x in sys.argv[3].split(",")]
lab = PLab(MODEL_4B)
vec = load_vec(lab, theme, tag)
print({L: round(mx.linalg.norm(u).item(), 3) for L, u in vec.items()})
for sc in scales:
    print("--- scale", sc)
    for kind, p in SELECT[0::2] + SELECT[1::4]:
        rows = [{"post": {L: u * (sc * lab.resid[L]) for L, u in vec.items()}}] * 3
        r = lab.sample_batch(lab.chat_ids(p), rows, max_tokens=60, seed=11)
        for x in r[:2]:
            print(f"[{kind}] {x['text'][:230]!r} rep={x['repetition']}")

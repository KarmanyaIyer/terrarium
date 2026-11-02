"""Theme-specific and style neurons from the lens: mass gained for one theme minus the median over all themes, among neurons that don't blow up the
distribution. Writes results/lens_picks.json. Usage: lens_pick.py [dose] [kl_max]"""
import glob, json, os, re, sys
import numpy as np
from transformers import AutoTokenizer
from common import CACHE, MODEL_4B
dose = sys.argv[1] if len(sys.argv) > 1 else "0.3"
kl_max = float(sys.argv[2]) if len(sys.argv) > 2 else 3.0
d = os.path.join(CACHE, "lens", f"Qwen3.5-4B-MLX-4bit-d{dose}")
tok = AutoTokenizer.from_pretrained(MODEL_4B)
picks = []
for p in sorted(glob.glob(os.path.join(d, "L*.npz"))):
    m = re.match(r"L(\d+)([pm])", os.path.basename(p))
    L, sign = int(m.group(1)), 1 if m.group(2) == "p" else -1
    z = np.load(p, allow_pickle=True)
    kl, top_id, mass = z["kl"], z["top_id"], z["mass"]
    names = [str(x) for x in z["names"]]
    spec = mass - np.median(mass, axis=1, keepdims=True)
    ok = (kl > 0.02) & (kl < kl_max)
    for ti, t in enumerate(names):
        col = np.where(ok, spec[:, ti], -1e9)
        for n in np.argsort(-col)[:3]:
            if col[n] > 0.5:
                picks.append({"theme": t, "ref": f"L{L}N{n}", "layer": L, "neuron": int(n), "sign": sign, "spec": round(float(col[n]), 2), "kl": round(float(kl[n]), 2), "tokens": [tok.decode([int(x)]) for x in top_id[n][:8]]})
picks.sort(key=lambda r: -r["spec"])
json.dump(picks, open("results/lens_picks.json", "w"), ensure_ascii=False, indent=0)
print(len(picks))
seen = set()
for r in picks:
    if r["ref"] in seen: continue
    seen.add(r["ref"])
    if len(seen) > 45: break
    print(r["theme"], r["ref"], "+" if r["sign"] > 0 else "-", r["spec"], "kl", r["kl"], r["tokens"][:6])

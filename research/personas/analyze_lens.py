"""Reads the lens scan: shortlists per theme (log-mass gained by the theme's tokens) and style groups (what kind of tokens get pushed).
Writes results/lens_shortlist.json and results/lens_topical.jsonl (neurons whose top tokens hang together, for labeling)."""
import glob
import json
import os
import re
import sys

import numpy as np
from transformers import AutoTokenizer

from common import CACHE, MODEL_4B, RESULTS

dose = sys.argv[1] if len(sys.argv) > 1 else "0.3"
d = os.path.join(CACHE, "lens", f"{os.path.basename(MODEL_4B.rstrip(chr(47)))}-d{dose}")
tok = AutoTokenizer.from_pretrained(MODEL_4B)
dec_cache = {}


def dec(t):
    t = int(t)
    if t not in dec_cache:
        dec_cache[t] = tok.decode([t])
    return dec_cache[t]


STYLE = {
    "caps": lambda s: len(s.strip()) >= 2 and s.strip().isupper() and s.strip().isalpha(),
    "emoji": lambda s: bool(re.search(r"[\U0001F300-\U0001FAFF☀-➿]", s)),
    "cjk": lambda s: bool(re.search(r"[㐀-鿿]", s)),
    "kana_hangul": lambda s: bool(re.search(r"[぀-ヿ가-힯]", s)),
    "cyrillic": lambda s: bool(re.search(r"[Ѐ-ӿ]", s)),
    "arabic_hebrew": lambda s: bool(re.search(r"[֐-ۿ]", s)),
    "digits": lambda s: bool(re.fullmatch(r"\s*\d+\s*", s)),
    "punct": lambda s: bool(re.fullmatch(r"\s*[^\w\s]+\s*", s)),
    "archaic": lambda s: s.strip().lower() in {"thou", "thee", "thy", "thine", "hath", "doth", "ye", "yea", "nay", "behold", "shall", "verily", "alas", "forsooth", "whence", "hither", "thus", "art"},
    "slang": lambda s: s.strip().lower() in {"bro", "dude", "lol", "lmao", "yo", "fam", "omg", "yeah", "nah", "gonna", "wanna", "haha", "wow", "cool", "guys", "dude"},
    "curse": lambda s: s.strip().lower() in {"damn", "hell", "shit", "fuck", "bastard", "crap", "bloody", "stupid", "idiot"},
    "romance": lambda s: bool(re.fullmatch(r"\s*(el|la|los|las|le|les|un|une|des|der|die|das|und|que|por|para|il|di|est|sur|avec|ein|eine)\s*", s, re.I)),
}

files = sorted(glob.glob(os.path.join(d, "*.npz")))
print("layer-signs scanned", len(files))
names = None
best_theme, best_style = {}, {}
topical = []
for path in files:
    m = re.search(r"L(\d+)([pm])\.npz", path)
    L, sign = int(m.group(1)), 1 if m.group(2) == "p" else -1
    z = np.load(path, allow_pickle=False)
    kl, top_id, top_d, mass = z["kl"], z["top_id"], z["top_d"], z["mass"]
    names = [str(x) for x in z["names"]]
    # theme: mass gained, neurons that do something but don't blow up the distribution
    for ti, t in enumerate(names):
        col = mass[:, ti]
        order = np.argsort(-col)[:8]
        for n in order:
            best_theme.setdefault(t, []).append((float(col[n]), L, int(n), sign, float(kl[n]), [dec(x) for x in top_id[n][:6]]))
    # style and topical groups only where the neuron moves something
    active = np.where(kl > 0.05)[0]
    for n in active:
        toks = [dec(x) for x in top_id[n]]
        for sname, fn in STYLE.items():
            hits = sum(fn(s) for s in toks)
            if hits >= 4:
                best_style.setdefault(sname, []).append((hits + float(top_d[n].mean()) / 100, L, int(n), sign, float(kl[n]), toks[:6]))
        words = [s.strip().lower() for s in toks if re.fullmatch(r"\s*[A-Za-z]{3,}\s*", s)]
        if len(set(words)) >= 5:
            topical.append({"ref": f"L{L}N{n}{'+' if sign > 0 else '-'}", "kl": round(float(kl[n]), 2), "gain": round(float(top_d[n].mean()), 1), "tokens": toks})
out = {"themes": {}, "styles": {}}
for t, rows in best_theme.items():
    rows.sort(key=lambda x: -x[0])
    out["themes"][t] = [{"gain": round(a, 2), "ref": f"L{L}N{n}", "sign": s, "kl": round(k, 2), "tokens": tk} for a, L, n, s, k, tk in rows[:12]]
for t, rows in best_style.items():
    rows.sort(key=lambda x: -x[0])
    out["styles"][t] = [{"score": round(a, 2), "ref": f"L{L}N{n}", "sign": s, "kl": round(k, 2), "tokens": tk} for a, L, n, s, k, tk in rows[:25]]
os.makedirs(RESULTS, exist_ok=True)
SUF = "" if "Qwen3.5-4B" in MODEL_4B else "_" + os.path.basename(MODEL_4B.rstrip(chr(47)))
json.dump(out, open(os.path.join(RESULTS, f"lens_shortlist{SUF}.json"), "w"), ensure_ascii=False, indent=0)
with open(os.path.join(RESULTS, f"lens_topical{SUF}.jsonl"), "w") as f:
    for r in sorted(topical, key=lambda r: -r["gain"]):
        f.write(json.dumps(r, ensure_ascii=False) + "\n")
print("topical", len(topical), "styles", {k: len(v) for k, v in best_style.items()})
for t in list(out["themes"])[:60]:
    r = out["themes"][t][0]
    print(t, r["ref"], r["sign"], r["gain"], r["kl"], r["tokens"][:5])

"""Held-out through the app's current lab core (apps/backend/scripts/lab_core.py), Lab.reply, read-only, with the repeat control that strains chat with.
Same prompts, seeds and sampling as heldout.py. Writes results/heldout/<name>.jsonl, name is <prefix>app-<spec name>-r<repeat>, prefix lfm- is kept so ho2judge cuts at </think>.
Usage: app_heldout.py <spec file> <repeat>"""
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "../../apps/backend/scripts"))
import lab_core as app  # noqa: E402

from common import CACHE, HELDOUT, HELDOUT_SEEDS, MODEL_4B, RESULTS, append_jsonl, read_jsonl  # noqa: E402

spec = json.load(open(sys.argv[1]))
repeat = float(sys.argv[2])
base = spec["name"]
name = ("lfm-app-" + base[4:] if base.startswith("lfm-") else "app-" + base) + f"-r{repeat}"
assert app.__file__.endswith("apps/backend/scripts/lab_core.py"), app.__file__
lab = app.Lab(MODEL_4B, cache_dir=os.path.join(CACHE, "app"))
path = os.path.join(RESULTS, "heldout", f"{name}.jsonl")
done = {(r["prompt"], r["seed"]) for r in read_jsonl(path)}
if not done:
    append_jsonl(os.path.join(RESULTS, "heldout.jsonl"), {**spec, "name": name, "repeat": repeat, "path": "app lab_core Lab.reply", "started": time.strftime("%Y-%m-%d %H:%M:%S")})
for kind, p in HELDOUT:
    ids = lab.chat_ids(p)
    for seed in HELDOUT_SEEDS:
        if (p, seed) in done:
            continue
        r = lab.reply(ids, spec["pushes"], 1.0, seed, 0.7, 120, repeat=repeat)
        append_jsonl(path, {"name": name, "kind": kind, "prompt": p, "seed": seed, "text": r["text"], "tokens": r["tokens"], "finish": r["finish"], "repetition": r["repetition"], "loop": r.get("loop"), "fluency": r.get("fluency")})
print(name, "done", flush=True)

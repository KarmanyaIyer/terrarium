"""A Field Guide specimen under the settings its strain chat uses today: the session system prompt, thinking off, the
stored temperature, top_p and repeat, the stop tokens, through the app's own lab core. Same prompts and seeds as
chat_check.py, so the two differ only in settings. Token cap 300 stands in for the session's budget.
Writes results/heldout/session-<specimen id>.jsonl. Usage: P_MODEL=<model dir> session_check.py <specimen id>"""
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "../../apps/backend/scripts"))
import lab_core as app  # noqa: E402

from common import CACHE, HELDOUT, HELDOUT_SEEDS, MODEL_4B, RESULTS, append_jsonl, read_jsonl  # noqa: E402

SYSTEM = "You are a helpful assistant. Answer directly and concisely."  # CHAT_PROMPT, apps/backend/src/harness/prompts.ts
CAP = 300
guide = json.load(open(os.path.join(HERE, "../../apps/backend/scripts/field_guide.json")))
spec = next(s for s in guide["specimens"] if s["id"] == sys.argv[1])
assert spec["modelId"] in MODEL_4B, (spec["modelId"], MODEL_4B)
name = f"session-{spec['id']}"
st = spec["settings"]
lab = app.Lab(MODEL_4B, cache_dir=os.path.join(CACHE, "app"))
path = os.path.join(RESULTS, "heldout", f"{name}.jsonl")
done = {(r["prompt"], r["seed"]) for r in read_jsonl(path)}
stops = lab.stop_ids()
assert st["topP"] == 0.95  # Lab.reply's top_p
for kind, p in HELDOUT:
    ids = lab.chat_ids(p, system=SYSTEM)
    for seed in HELDOUT_SEEDS[:8]:
        if (p, seed) in done:
            continue
        r = lab.reply(ids, spec["mix"], 1.0, seed, st["temperature"], CAP, repeat=st["repeat"], stops=stops)
        append_jsonl(path, {"name": name, "kind": kind, "prompt": p, "seed": seed, "text": r["text"], "tokens": r.get("tokens"), "finish": r.get("finish"), "t": time.time()})
print(name, "done", flush=True)

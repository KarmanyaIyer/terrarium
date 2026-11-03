"""A Field Guide specimen under the settings its strain chat uses today: the session system prompt, thinking off, the
stored temperature, top_p and repeat, the stop tokens, through the app's own lab core. Same prompts and seeds as
chat_check.py, so the two differ only in settings. Token cap 300 stands in for the session's budget.
Writes results/heldout/session-<specimen id>[-r<repeat>].jsonl. Usage: P_MODEL=<model dir> session_check.py <specimen id> [repeat]"""
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
# field_guide.json was built when the 4B Tiger and La Dame de Fer files held 9B vectors. Run the recipe as tested.
if spec["mix"][0].get("kind") == "vector" and spec["id"] in ("qwen3-5-4b-i-the-tiger", "qwen3-5-4b-la-dame-de-fer"):
    import base64

    import numpy as np
    import mlx.core as mx

    from session_judge import persona

    r = persona(spec)["recipe"]
    u = mx.load(os.path.join(HERE, "../..", r["vector_file"]))[r["vector_key"]]
    spec["mix"][0]["u"] = base64.b64encode(np.array(u, dtype=np.float32).tobytes()).decode()
st = dict(spec["settings"])
name = f"session-{spec['id']}"
if len(sys.argv) > 2:  # the same recipe with another repeat penalty
    st["repeat"] = float(sys.argv[2])
    name += f"-r{sys.argv[2]}"
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

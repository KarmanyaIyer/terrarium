"""A Field Guide specimen as a real strain chat runs it: lab_serve.chat_completion, the function the app's sidecar serves
/v1/chat/completions with, with the strain registered as the app registers it. No system prompt (harness/profiles.ts: a
strain in a plain chat sends none). Thinking off, stop tokens, stored temperature, top_p, repeat and maxTokens all come from
that path. Same prompts and seeds as chat_check.py; a real chat picks a random seed, a fixed one makes the run repeatable.

Reads a frozen copy of field_guide.json (.cache/guide_frozen.json, from commit 61ecf21), so a guide rebuild can't change a
run's settings halfway. Earlier runs that sent "You are a helpful assistant. Answer directly and concisely." are kept as
withprompt-session-<id>.

Writes results/heldout/session-<id>[-r<repeat>].jsonl. Usage: P_MODEL=<model dir> session_check.py <specimen id> [repeat]"""
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "../../apps/backend/scripts"))
import lab_serve as serve  # noqa: E402

from common import CACHE, HELDOUT, HELDOUT_SEEDS, MODEL_4B, RESULTS, append_jsonl, read_jsonl  # noqa: E402

guide = json.load(open(os.path.join(HERE, ".cache/guide_frozen.json")))
spec = next(s for s in guide["specimens"] if s["id"] == sys.argv[1])
assert spec["modelId"] in MODEL_4B, (spec["modelId"], MODEL_4B)
settings = dict(spec["settings"])
name = f"session-{spec['id']}"
if len(sys.argv) > 2:  # the same recipe with another repeat penalty
    settings["repeat"] = float(sys.argv[2])
    name += f"-r{sys.argv[2]}"
assert settings["maxTokens"] == 300, settings
lab = serve.Lab(MODEL_4B, cache_dir=os.path.join(CACHE, "app"))
serve.S.lab = lab
serve.check_settings(settings)
lab.check_mix(spec["mix"])
lab.strains["s"] = {"pushes": spec["mix"], "settings": settings}
path = os.path.join(RESULTS, "heldout", f"{name}.jsonl")
done = {(r["prompt"], r["seed"]) for r in read_jsonl(path)}
for kind, p in HELDOUT:
    for seed in HELDOUT_SEEDS[:8]:
        if (p, seed) in done:
            continue
        # The session's request budget is larger than the strain's cap; the strain's maxTokens wins, as in the app.
        body = {"model": "strain:s", "messages": [{"role": "user", "content": p}], "seed": seed, "max_tokens": 8192}
        r = serve.chat_completion(body, None)
        c = r["choices"][0]
        append_jsonl(path, {"name": name, "kind": kind, "prompt": p, "seed": seed, "text": c["message"].get("content") or "", "reasoning": c["message"].get("reasoning_content"), "tokens": r["usage"]["completion_tokens"], "prompt_tokens": r["usage"]["prompt_tokens"], "finish": c["finish_reason"], "t": time.time()})
print(name, "done", flush=True)

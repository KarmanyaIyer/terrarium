"""The same recipes under the settings a strain chat session uses, not the Lab Compare settings of the metric: the session system prompt, thinking off, the session's sampling, repeat 1.1, a longer cap.
Qwen: temperature 0.7, top_p 0.8, top_k 20. LFM3: temperature 0.1, top_p 1.0, top_k 50. From apps/backend/src (catalog settings, CHAT_PROMPT). 8 seeds per held-out prompt, N=48.
Writes results/heldout/chat-<run>.jsonl. Usage: chat_check.py <spec file> <run name> [max_tokens]"""
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "../../apps/backend/scripts"))
import lab_core as app  # noqa: E402

from common import CACHE, HELDOUT, HELDOUT_SEEDS, MODEL_4B, RESULTS, append_jsonl, read_jsonl  # noqa: E402

SYSTEM = "You are a helpful assistant. Answer directly and concisely."
spec = json.load(open(sys.argv[1]))
run = sys.argv[2]
cap = int(sys.argv[3]) if len(sys.argv) > 3 else 300
temp, top_p, top_k = (0.1, 1.0, 50) if "LFM3" in MODEL_4B else (0.7, 0.8, 20)
name = f"chat-{run}"
lab = app.Lab(MODEL_4B, cache_dir=os.path.join(CACHE, "app"))
path = os.path.join(RESULTS, "heldout", f"{name}.jsonl")
done = {(r["prompt"], r["seed"]) for r in read_jsonl(path)}
if not done:
    append_jsonl(os.path.join(RESULTS, "heldout.jsonl"), {**spec, "name": name, "repeat": lab.STRAIN_REPEAT, "path": "app lab_core stream, chat session settings", "system": SYSTEM, "temperature": temp, "top_p": top_p, "top_k": top_k, "max_tokens": cap, "started": time.strftime("%Y-%m-%d %H:%M")})
for kind, p in HELDOUT:
    ids = lab.chat_ids(p, system=SYSTEM)
    for seed in HELDOUT_SEEDS[:8]:
        if (p, seed) in done:
            continue
        sampler, procs = lab.sampler_for(temp, top_p=top_p, top_k=top_k, repeat=lab.STRAIN_REPEAT)
        lab.apply_mix(spec["pushes"])
        toks, text, finish = [], "", None
        try:
            for r in lab.stream(ids, cap, sampler, procs, seed=seed):
                text += r.text or ""
                if r.finish_reason is None or r.finish_reason == "length":
                    toks.append(r.token)
                finish = r.finish_reason or finish
        finally:
            lab.clear()
        append_jsonl(path, {"name": name, "kind": kind, "prompt": p, "seed": seed, "text": text, "tokens": len(toks), "finish": finish, "repetition": app.repetition(toks), "loop": app.is_loop(toks)})
print(name, "done", flush=True)

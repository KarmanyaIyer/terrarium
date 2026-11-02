"""Generator A end to end, with no human choice after the word list: word in, one neuron and dose out, then the held-out run.
Runs through the app's lab core at repeat 1.1. Fixed rule:
 1. Lens lookup: rows whose top tokens contain the word's stem, KL at most 3, late layers. Rank by matching tokens, then gain. Top 2.
 2. Doses high to low, 16 replies per dose on the selection prompts, 120 tokens.
 3. Keep the first dose with stem hit at least .9 and distinct bigrams at least .95. Between candidates, the higher hit wins.
 4. Held-out on the normal 144 prompts and seeds.
Usage: gen_word.py word,word,..."""
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "../../apps/backend/scripts"))
import lab_core as app  # noqa: E402

from common import CACHE, HELDOUT, HELDOUT_SEEDS, MODEL_4B, RESULTS, SELECT, append_jsonl, read_jsonl  # noqa: E402
from score import distinct_bigrams  # noqa: E402

REPEAT = 1.1
LFM = "LFM3" in MODEL_4B
SUF = "" if "Qwen3.5-4B" in MODEL_4B else "_" + os.path.basename(MODEL_4B.rstrip("/"))
LAYERS = (16, 17, 18) if LFM else (18, 22)
DOSES = (3.0, 2.2, 1.5, 0.8) if LFM else (1.2, 0.9, 0.75, 0.6)
out = os.path.join(RESULTS, f"gen_word{SUF}.jsonl")
words = sys.argv[1].split(",")
done = {r["word"] for r in read_jsonl(out)}
lens = [r for r in read_jsonl(os.path.join(RESULTS, f"lens_topical{SUF}.jsonl")) if r["kl"] <= 3.0 and int(r["ref"][1:].split("N")[0]) in LAYERS]


def lookup(word):
    stem = word[: max(4, len(word) - 1)]
    rows = []
    for r in lens:
        m = sum(t.strip().lower().startswith(stem) for t in r["tokens"])
        if m:
            rows.append((m, r["gain"], r["ref"], r["tokens"]))
    rows.sort(reverse=True)
    return stem, rows[:2]


lab = None
for word in words:
    if word in done:
        continue
    stem, cands = lookup(word)
    rec = {"word": word, "stem": stem, "candidates": [c[2] for c in cands], "screens": [], "pick": None, "time": time.strftime("%Y-%m-%d %H:%M")}
    if not cands:
        rec["fail"] = "no neuron in the lens table"
        append_jsonl(out, rec)
        print(word, "no neuron", flush=True)
        continue
    if lab is None:
        lab = app.Lab(MODEL_4B, cache_dir=os.path.join(CACHE, "app"))
    rx = re.compile(re.escape(stem), re.I)
    picks = []
    for m, gain, ref, toks in cands:
        sign = 1 if ref.endswith("+") else -1
        L, n = map(int, ref.rstrip("+-")[1:].split("N"))
        for d in DOSES:
            push = [{"layer": L, "neuron": n, "mode": "dose", "value": sign * d}]
            texts = []
            for _, p in SELECT:
                ids = lab.chat_ids(p)
                for seed in (100, 101):
                    t = lab.reply(ids, push, 1.0, seed, 0.7, 120, repeat=REPEAT)["text"]
                    texts.append(t.split("</think>")[0])
            hit = sum(bool(rx.search(t)) for t in texts) / len(texts)
            bi = sum(distinct_bigrams(t) for t in texts) / len(texts)
            rec["screens"].append({"ref": ref, "tokens": toks[:6], "dose": sign * d, "hit": round(hit, 3), "bigrams": round(bi, 3), "sample": texts[0][:160]})
            print(word, ref, sign * d, "hit", round(hit, 2), "bi", round(bi, 3), flush=True)
            if hit >= 0.9 and bi >= 0.95:
                picks.append((hit, L, n, sign * d))
                break
            if hit < 0.5:
                break
    if not picks:
        rec["fail"] = "no dose passed"
        append_jsonl(out, rec)
        continue
    hit, L, n, dose = max(picks)
    tid = "g" + word
    d = json.load(open("lex_themes.json"))
    d[tid] = {"group": "words", "trait": f"obsessed with {word}: keeps working {word} into every reply, whatever the question", "words": stem}
    json.dump(d, open("lex_themes.json", "w"), indent=1, ensure_ascii=False)
    hn = ("lfm-" if LFM else "") + f"lex-{tid}-{dose:+.2f}"
    spec = {"name": hn, "theme": tid, **({"model": "LFM3"} if LFM else {}), "description": f"generator test: single neuron L{L}N{n} at {dose:+.2f}", "pushes": [{"layer": L, "neuron": n, "mode": "dose", "value": dose}]}
    json.dump(spec, open(f"specs/{hn}.json", "w"))
    name = ("lfm-app-" + hn[4:] if LFM else "app-" + hn) + f"-r{REPEAT}"
    c = json.load(open("catalog.json"))
    c[name] = {"name": f"{word.capitalize()} (generator test{', LFM3' if LFM else ''})", "blurb": f"Chosen by gen_word.py with no human pick: L{L}N{n}{dose:+.2f}, repeat 1.1.", "group": "words", "settings": {"repeat": REPEAT, "path": "app lab_core Lab.reply", **({"stop": ["</think>"]} if LFM else {})}, **({"model": "LFM3-1.7B-MLX-8bit"} if LFM else {})}
    json.dump(c, open("catalog.json", "w"), indent=1, ensure_ascii=False)
    rec["pick"] = {"ref": f"L{L}N{n}", "dose": dose, "hit": hit, "run": name}
    append_jsonl(out, rec)
    path = os.path.join(RESULTS, "heldout", f"{name}.jsonl")
    fin = {(r["prompt"], r["seed"]) for r in read_jsonl(path)}
    if not fin:
        append_jsonl(os.path.join(RESULTS, "heldout.jsonl"), {**spec, "name": name, "repeat": REPEAT, "path": "app lab_core Lab.reply", "started": time.strftime("%Y-%m-%d %H:%M")})
    for kind, p in HELDOUT:
        ids = lab.chat_ids(p)
        for seed in HELDOUT_SEEDS:
            if (p, seed) in fin:
                continue
            r = lab.reply(ids, spec["pushes"], 1.0, seed, 0.7, 120, repeat=REPEAT)
            append_jsonl(path, {"name": name, "kind": kind, "prompt": p, "seed": seed, "text": r["text"], "tokens": r["tokens"], "finish": r["finish"], "repetition": r["repetition"]})
    print(word, "held-out done", name, flush=True)

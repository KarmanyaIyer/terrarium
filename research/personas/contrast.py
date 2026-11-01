"""Persona directions per theme and layer. A: persona prompted reply vs neutral reply. B: same persona text read under the
neutral prompt vs neutral reply (no system prompt in the contrast). Resume-safe: one .cache/vec/<model>/<theme>.safetensors each."""

import os
import sys
import time

import mlx.core as mx

from common import CACHE, CONTRAST, MODEL_4B, append_jsonl, read_jsonl
from plab import PLab
from themes import BY_ID, THEMES, TRANSFORMS

MAX_TOK = 70


def neutral_texts(lab, out):
    """One neutral reply per contrast prompt, shared by all themes."""
    path = os.path.join(out, "neutral.jsonl")
    done = {r["prompt"]: r for r in read_jsonl(path)}
    for i, p in enumerate(CONTRAST):
        if p not in done:
            r = lab.sample_batch(lab.chat_ids(p), [{}], max_tokens=MAX_TOK, seed=i)[0]
            done[p] = {"prompt": p, "text": r["text"], "ids": r["ids"]}
            append_jsonl(path, done[p])
    return done


def run_theme(lab, theme, neutral, out, neutral_res):
    path = os.path.join(out, f"{theme['id']}.safetensors")
    if os.path.exists(path):
        return
    t0 = time.time()
    a, b, n = 0, 0, 0
    texts = []
    for i, p in enumerate(CONTRAST):
        np_ids = lab.chat_ids(p)
        if theme["id"] in TRANSFORMS:
            text = TRANSFORMS[theme["id"]](neutral[p]["text"])
            ids = lab.tok.encode(text, add_special_tokens=False)[: MAX_TOK * 3]
            sys_res = None
        else:
            sp_ids = lab.chat_ids(p, system=theme["system"])
            r = lab.sample_batch(sp_ids, [{}], max_tokens=MAX_TOK, seed=1000 + i)[0]
            ids, text = r["ids"], r["text"]
            if len(ids) < 3:
                continue
            sys_res = lab.residuals(sp_ids + ids, len(sp_ids))
        read = lab.residuals(np_ids + ids, len(np_ids))
        if sys_res is not None:
            a = a + (sys_res - neutral_res[p])
        b = b + (read - neutral_res[p])
        n += 1
        mx.eval(a, b)
        texts.append({"prompt": p, "text": text})
    if theme["id"] in TRANSFORMS:
        a = b
    mx.save_safetensors(path, {"a": a / n, "b": b / n})
    append_jsonl(os.path.join(out, "persona_texts.jsonl"), {"theme": theme["id"], "texts": texts})
    print(theme["id"], f"{time.time() - t0:.0f}s", texts[0]["text"][:100].replace("\n", " "), flush=True)


def main():
    ids = sys.argv[1:] or [t["id"] for t in THEMES]
    lab = PLab(MODEL_4B)
    out = os.path.join(CACHE, "vec", lab.model_id)
    os.makedirs(out, exist_ok=True)
    neutral = neutral_texts(lab, out)
    neutral_res = {}
    for p in CONTRAST:
        nid = lab.chat_ids(p)
        neutral_res[p] = lab.residuals(nid + neutral[p]["ids"], len(nid))
    for t in ids:
        run_theme(lab, BY_ID[t], neutral, out, neutral_res)


if __name__ == "__main__":
    main()

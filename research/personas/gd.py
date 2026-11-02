"""Gradient recipes: find a residual vector at one layer (or several) that makes the unprompted model imitate persona text.

Loss: mean cross entropy of persona reply tokens given the neutral prompt (no system prompt), steered at every position.
Each example runs prompt and earlier reply without gradients into the cache, then K tokens with gradients, so memory stays
flat. The vector is kept inside a norm ball in units of the layer's median residual norm.
"""

import json
import os
import random
import sys
import time

import mlx.core as mx
import mlx.optimizers as optim
from mlx_lm.models.cache import make_prompt_cache

from common import CACHE, CONTRAST, MODEL_4B, append_jsonl, read_jsonl
from lab_core import _sdpa_ops
from plab import PLab

K = 10


def persona_examples(lab, theme):
    path = os.path.join(CACHE, "vec", lab.model_id, os.environ.get("PERSONA_TEXTS", "persona_texts.jsonl"))
    for row in read_jsonl(path):
        if row["theme"] == theme:
            out = []
            for t in row["texts"]:
                ids = lab.tok.encode(t["text"], add_special_tokens=False)
                if len(ids) >= 8:
                    out.append((lab.chat_ids(t["prompt"]), ids))
            return out
    raise SystemExit(f"no persona texts for {theme}")


def optimize(lab, theme, layers, radius=0.6, steps=60, batch=6, lr=0.003, seed=0, init=None, neg=0.0, neutral=None, log=print):
    rng = random.Random(seed)
    exs = persona_examples(lab, theme)
    unit = [lab.resid[L] for L in layers]
    if init is None:
        params = {"u": [mx.zeros((lab.d_model,), dtype=mx.float32) for _ in layers]}
    else:
        params = {"u": [mx.array(i).astype(mx.float32) for i in init]}
    opt = optim.Adam(learning_rate=lr)
    fast = mx.fast.scaled_dot_product_attention
    t0 = time.time()
    hist = []
    for step in range(steps):
        total, grads_acc = 0.0, None
        for _ in range(batch):
            prompt, reply = rng.choice(exs)
            full = prompt + reply
            start = len(prompt) - 1 if rng.random() < 0.5 else rng.randrange(len(prompt) - 1, max(len(prompt), len(full) - K - 1))
            lab.clear()
            for L, u, s in zip(layers, params["u"], unit):
                lab.hooks[L].post = u * s
            cache = make_prompt_cache(lab.model)
            lab.model.eval()
            lab.model(mx.array(full[:start])[None], cache=cache)
            mx.eval([c.state for c in cache])
            xx = mx.array(full[start : start + K])[None]
            y = mx.array(full[start + 1 : start + K + 1])
            lab.model.train()
            mx.fast.scaled_dot_product_attention = _sdpa_ops

            def loss_fn(p):
                for L, u, s in zip(layers, p["u"], unit):
                    lab.hooks[L].post = u * s
                lg = lab.model(xx, cache=cache)[0].astype(mx.float32)
                n = min(lg.shape[0], y.shape[0])
                lg = lg[:n]
                lp = lg - mx.logsumexp(lg, axis=-1, keepdims=True)
                return -mx.take_along_axis(lp, y[:n, None], axis=-1).mean()

            try:
                loss, grads = mx.value_and_grad(loss_fn)(params)
                mx.eval(loss, grads)
            finally:
                mx.fast.scaled_dot_product_attention = fast
                lab.model.eval()
                lab.clear()
            total += loss.item()
            g = [gi for gi in grads["u"]]
            grads_acc = g if grads_acc is None else [a + b for a, b in zip(grads_acc, g)]
        grads_acc = {"u": [a / batch for a in grads_acc]}
        opt.update(params, grads_acc)
        # stay inside the ball: total push across layers
        sq = sum((u * u).sum() for u in params["u"])
        nrm = mx.sqrt(sq).item()
        if nrm > radius:
            params["u"] = [u * (radius / nrm) for u in params["u"]]
        mx.eval(params)
        hist.append(total / batch)
        if step % 10 == 0 or step == steps - 1:
            log(f"  step {step} loss {total / batch:.3f} |u| {min(nrm, radius):.3f} {time.time() - t0:.0f}s")
    return [mx.array(u) for u in params["u"]], hist


def save_vec(lab, theme, tag, layers, us):
    out = os.path.join(CACHE, "gd", lab.model_id)
    os.makedirs(out, exist_ok=True)
    mx.save_safetensors(os.path.join(out, f"{theme}__{tag}.safetensors"), {f"u{L}": u for L, u in zip(layers, us)})


def load_vec(lab, theme, tag):
    d = mx.load(os.path.join(CACHE, "gd", lab.model_id, f"{theme}__{tag}.safetensors"))
    return {int(k[1:]): v for k, v in d.items()}


if __name__ == "__main__":
    theme = sys.argv[1]
    layers = [int(x) for x in sys.argv[2].split(",")]
    radius = float(sys.argv[3]) if len(sys.argv) > 3 else 0.6
    steps = int(sys.argv[4]) if len(sys.argv) > 4 else 60
    lab = PLab(MODEL_4B)
    us, _ = optimize(lab, theme, layers, radius=radius, steps=steps)
    tag = "L" + "_".join(map(str, layers)) + f"_r{radius}"
    save_vec(lab, theme, tag, layers, us)
    print(mx.get_peak_memory() / 1e9, "GB peak")

"""Measured steer lens over every neuron and both signs: push by a small dose, read the next token at open contexts.

Runs layers after L only, from the cached unsteered residual, so one batch costs (31 - L) layers. Writes one .npz per layer
and sign: KL, top gained tokens, and log-mass gained by each theme's tokens. Resume-safe.
"""

import os
import re
import sys
import time

import mlx.core as mx
import numpy as np
from mlx_lm.models.base import create_attention_mask

from common import CACHE, MODEL_4B
from lab_core import _RESID
from plab import PLab
from themes import THEMES

CONTEXTS = [
    ("Tell me a little about who you are.", "I am"),
    ("Tell me a short tale.", "Once upon a time, there was a"),
    ("What are you up to this weekend?", "I"),
    ("What is the most important thing to know about life?", "The"),
]
BATCH = 96


def theme_tokens(lab):
    out = {}
    for t in THEMES:
        toks = set()
        for w in re.split(r"\|", t["words"]):
            w = w.strip()
            if not re.fullmatch(r"[A-Za-z' ]+", w) or len(w) < 3:
                continue
            for form in (" " + w, " " + w.capitalize(), w, w.capitalize()):
                ids = lab.tok.encode(form, add_special_tokens=False)
                if ids and len(lab.tok.decode(ids[:1]).strip()) >= 3:
                    toks.add(ids[0])
        if toks:
            out[t["id"]] = sorted(toks)
    return out


def base_states(lab):
    """For each context: every layer's unsteered residual, and the unsteered next-token log-probs."""
    states = []
    for q, pre in CONTEXTS:
        ids = lab.chat_ids(q, prefill=pre)
        for layer in lab.layers:
            _RESID[id(layer)] = []
        try:
            x = mx.array(ids)[None]
            h = lab.inner(x)
            resid = [_RESID[id(layer)][0] for layer in lab.layers]
            lg = lab._unembed(h)[0, -1].astype(mx.float32)
            lp = lg - mx.logsumexp(lg)
            mx.eval(resid, lp)
        finally:
            for layer in lab.layers:
                _RESID.pop(id(layer), None)
        states.append((resid, lp))
    return states


def tail(lab, h, L):
    """Run layers after L on [B, T, d], return last-position log-probs [B, V]."""
    mask = create_attention_mask(h, None)
    for i in range(L + 1, lab.n_layers):
        layer = lab.layers[i]
        h = layer(h, mask=None if layer.is_linear else mask, cache=None)
    lg = lab._unembed(lab.inner.norm(h[:, -1:]))[:, 0].astype(mx.float32)
    return lg - mx.logsumexp(lg, axis=-1, keepdims=True)


def scan_layer(lab, L, sign, dose, states, tokens, names, out):
    path = os.path.join(out, f"L{L}{'p' if sign > 0 else 'm'}.npz")
    if os.path.exists(path):
        return
    t0 = time.time()
    w = lab._down_weight(L)
    cols = (w / mx.maximum(lab.down_norm[L], 1e-6)[None, :]).T  # [N, d], unit length
    mx.eval(cols)
    del w
    N = lab.n_neurons[L]
    push = sign * dose * lab.resid[L]
    kl = np.zeros(N, np.float32)
    top_id = np.zeros((N, 8), np.int32)
    top_d = np.zeros((N, 8), np.float32)
    mass = np.zeros((N, len(names)), np.float16)
    idx = [mx.array(tokens[n]) for n in names]
    bases = [mx.stack([mx.logsumexp(lp[i]) for i in idx]) for _, lp in states]
    for s in range(0, N, BATCH):
        e = min(N, s + BATCH)
        v = cols[s:e][:, None, :] * push
        avg, k, ma = 0, 0, 0
        for (resid, base), bm in zip(states, bases):
            h0 = resid[L]
            h = h0 + v.astype(h0.dtype)
            lp = tail(lab, h, L)
            avg = avg + (lp - base)
            k = k + (mx.exp(lp) * (lp - base)).sum(axis=-1)
            ma = ma + (mx.stack([mx.logsumexp(lp[:, i], axis=-1) for i in idx], axis=1) - bm[None])
        avg = avg / len(states)
        ti = mx.argpartition(-avg, 8, axis=-1)[:, :8]
        td = mx.take_along_axis(avg, ti, axis=-1)
        mx.eval(ti, td, k, ma)
        kl[s:e] = np.array(k / len(states))
        top_id[s:e] = np.array(ti)
        top_d[s:e] = np.array(td)
        mass[s:e] = np.array((ma / len(states)).astype(mx.float16))
    np.savez_compressed(path, kl=kl, top_id=top_id, top_d=top_d, mass=mass, names=np.array(names), dose=dose)
    print(f"L{L} {'+' if sign > 0 else '-'} {time.time() - t0:.0f}s", flush=True)


def main():
    dose = float(sys.argv[1]) if len(sys.argv) > 1 else 0.5
    layers = [int(x) for x in sys.argv[2].split(",")] if len(sys.argv) > 2 else list(range(31, -1, -1))
    lab = PLab(MODEL_4B)
    tokens = theme_tokens(lab)
    names = sorted(tokens)
    out = os.path.join(CACHE, "lens", f"{lab.model_id}-d{dose}")
    os.makedirs(out, exist_ok=True)
    states = base_states(lab)
    for L in layers:
        for sign in (1, -1):
            scan_layer(lab, L, sign, dose, states, tokens, names, out)


if __name__ == "__main__":
    main()

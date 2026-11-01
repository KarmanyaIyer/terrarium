"""Lab subclass for the persona search: batched sampling with a mix per row, residual capture, dense vectors, reply-only."""

import sys
import time

import mlx.core as mx
from mlx_lm.models.cache import make_prompt_cache
from mlx_lm.sample_utils import apply_top_p

sys.path.insert(0, __file__.rsplit("/", 1)[0])
import lab_core  # noqa: E402
from lab_core import HookedDown, Lab, _RESID, repetition  # noqa: E402
from common import CACHE  # noqa: E402


def _call(self, x):
    """HookedDown plus `post`: a vector added to down_proj's output, [d] or [B, 1, d]."""
    h = self.hook
    if h.clamp_mask is not None:
        x = x * (1 - h.clamp_mask.astype(x.dtype)) + h.clamp_val.astype(x.dtype)
    if h.add is not None:
        x = x + h.add.astype(x.dtype)
    if h.delta is not None:
        x = x + h.delta
    if h.capture == "full":
        h.captured.append(x)
    elif h.capture == "max":
        h.captured.append(x[:, 1:].max(axis=1) if x.shape[1] > 1 else x[:, 0])
    y = self.inner(x)
    post = getattr(h, "post", None)
    return y if post is None else y + post.astype(y.dtype)


HookedDown.__call__ = _call


class PLab(Lab):
    def __init__(self, model_dir, **kw):
        super().__init__(model_dir, cache_dir=CACHE, log=lambda *a: None, **kw)
        self.eos = set(self.tok.eos_token_ids) if hasattr(self.tok, "eos_token_ids") else {self.tok.eos_token_id}
        mx.set_cache_limit(1 << 30)

    def clear(self):
        super().clear()
        for h in self.hooks:
            h.post = None

    # ---------- per-row interventions ----------

    def set_rows(self, rows):
        """rows: one spec per batch row: {pushes: [...], post: {layer: [d] array}}. Dose units as in apply_mix."""
        self.clear()
        B = len(rows)
        adds, posts = {}, {}
        for r, spec in enumerate(rows):
            for p in spec.get("pushes") or []:
                adds.setdefault(p["layer"], []).append((r, p["neuron"], p["value"] * self.dose_unit(p["layer"], p["neuron"])))
            for layer, vec in (spec.get("post") or {}).items():
                posts.setdefault(layer, []).append((r, vec))
        for layer, items in adds.items():
            rr = mx.array([i[0] for i in items])
            nn = mx.array([i[1] for i in items])
            vv = mx.array([i[2] for i in items], dtype=mx.float32)
            a = mx.zeros((B, self.hooks[layer].n), dtype=mx.float32).at[rr, nn].add(vv)
            self.hooks[layer].add = a[:, None, :]
        for layer, items in posts.items():
            a = mx.zeros((B, self.d_model), dtype=mx.float32)
            for r, vec in items:
                a = a.at[r].add(vec)
            self.hooks[layer].post = a[:, None, :]

    # ---------- batched sampling ----------

    def sample_batch(self, ids, rows, temperature=0.7, top_p=0.95, max_tokens=120, seed=0, presence=0.0, reply_only=False):
        """One prompt, one row per spec, all sampled in parallel. Rows are independent draws; finished rows pad until all end."""
        B = len(rows)
        mx.random.seed(int(seed))
        if not reply_only:
            self.set_rows(rows)
        else:
            self.clear()
        cache = make_prompt_cache(self.model)
        try:
            x = mx.broadcast_to(mx.array(ids)[None], (B, len(ids)))
            logits = self.model(x, cache=cache)[:, -1]
            mx.eval(logits, [c.state for c in cache])
            if reply_only:
                self.set_rows(rows)
            out = [[] for _ in range(B)]
            done = [False] * B
            seen = mx.zeros((B, logits.shape[-1]), dtype=mx.float32) if presence else None
            for step in range(max_tokens):
                lg = logits.astype(mx.float32)
                if presence:
                    lg = lg - presence * seen
                lp = lg - mx.logsumexp(lg, axis=-1, keepdims=True)
                lp = apply_top_p(lp, top_p)
                tok = mx.random.categorical(lp * (1 / temperature)) if temperature > 0 else mx.argmax(lp, axis=-1)
                mx.eval(tok)
                ts = tok.tolist()
                for i, t in enumerate(ts):
                    if not done[i]:
                        if t in self.eos:
                            done[i] = True
                        else:
                            out[i].append(t)
                if all(done):
                    break
                if presence:
                    seen = seen.at[mx.arange(B), tok].add(1.0)
                    seen = mx.minimum(seen, 1.0)
                logits = self.model(tok[:, None], cache=cache)[:, -1]
                mx.eval(logits, [c.state for c in cache])
        finally:
            self.clear()
        return [{"text": self.tok.decode(o), "ids": o, "tokens": len(o), "finished": d, "repetition": repetition(o)} for o, d in zip(out, done)]

    # ---------- captures ----------

    def residuals(self, ids, start):
        """Mean residual leaving each layer over positions >= start, with the current mix. [L, d] float32."""
        for layer in self.layers:
            _RESID[id(layer)] = []
        try:
            x = mx.array(ids)[None]
            self.inner(x)
            rows = []
            for layer in self.layers:
                o = _RESID[id(layer)][0][0, start:].astype(mx.float32)
                rows.append(o.mean(axis=0))
            m = mx.stack(rows)
            mx.eval(m)
            return m
        finally:
            for layer in self.layers:
                _RESID.pop(id(layer), None)

    def fluency_rows(self, ids, replies):
        """Unsteered mean log-prob of each reply; the fluency in Lab.reply."""
        return [self.fluency(ids, r["ids"]) if r["ids"] else -99.0 for r in replies]

"""Sparse gradient recipes: grow a neuron recipe directly against the persona-imitation loss.

Each round takes the gradient of the loss with respect to the residual at every candidate layer, scores all neurons by
|column . gradient| (how fast a dose on that neuron lowers the loss), adds the best few, and polishes doses with Adam inside
a norm ball. Doses are in the Lab's unit, so the result works with the stock apply_mix.
"""

import json
import os
import random
import sys
import time

import mlx.core as mx
import mlx.optimizers as optim
from mlx_lm.models.cache import make_prompt_cache

from common import CACHE, MODEL_4B, format_recipe
from gd import K, persona_examples
from lab_core import _sdpa_ops
from plab import PLab


class Sparse:
    def __init__(self, lab, theme, layers, seed=0, examples=None):
        self.lab, self.theme, self.layers = lab, theme, layers
        self.rng = random.Random(seed)
        self.exs = examples or persona_examples(lab, theme)
        self.cols = {}
        for L in layers:
            w = lab._down_weight(L)
            self.cols[L] = w / mx.maximum(lab.down_norm[L], 1e-6)[None, :]
            mx.eval(self.cols[L])
        self.support = []  # (layer, neuron)
        self.doses = mx.zeros((0,), dtype=mx.float32)
        self.fast = mx.fast.scaled_dot_product_attention

    def _vectors(self, doses):
        """{layer: [d] residual push} for the current support."""
        out = {}
        for i, (L, n) in enumerate(self.support):
            out[L] = out.get(L, 0) + doses[i] * self.lab.resid[L] * self.cols[L][:, n]
        return out

    def _window(self):
        prompt, reply = self.rng.choice(self.exs)
        full = prompt + reply
        start = len(prompt) - 1 if self.rng.random() < 0.5 else self.rng.randrange(len(prompt) - 1, max(len(prompt), len(full) - K - 1))
        return full, start

    def _grad(self, full, start, want_cols):
        """Loss and gradients for one window. Returns (loss, d loss/d doses, {layer: d loss/d residual in resid units})."""
        lab = self.lab
        lab.clear()
        vecs = self._vectors(self.doses)
        for L, v in vecs.items():
            lab.hooks[L].post = v
        cache = make_prompt_cache(lab.model)
        lab.model.eval()
        lab.model(mx.array(full[:start])[None], cache=cache)
        mx.eval([c.state for c in cache])
        x = mx.array(full[start : start + K])[None]
        y = mx.array(full[start + 1 : start + K + 1])
        lab.model.train()
        mx.fast.scaled_dot_product_attention = _sdpa_ops

        def loss_fn(p):
            vv = self._vectors(p["doses"])
            for L in self.layers:
                post = vv.get(L, None)
                if want_cols:
                    extra = p["u"][str(L)] * lab.resid[L]
                    post = extra if post is None else post + extra
                lab.hooks[L].post = post
            lg = lab.model(x, cache=cache)[0].astype(mx.float32)
            n = min(lg.shape[0], y.shape[0])
            lp = lg[:n] - mx.logsumexp(lg[:n], axis=-1, keepdims=True)
            return -mx.take_along_axis(lp, y[:n, None], axis=-1).mean()

        params = {"doses": self.doses}
        if want_cols:
            params["u"] = {str(L): mx.zeros((lab.d_model,), dtype=mx.float32) for L in self.layers}
        try:
            loss, g = mx.value_and_grad(loss_fn)(params)
            mx.eval(loss, g)
        finally:
            mx.fast.scaled_dot_product_attention = self.fast
            lab.model.eval()
            lab.clear()
        return loss.item(), g["doses"], g.get("u")

    def add_neurons(self, m, windows):
        acc = {str(L): 0 for L in self.layers}
        total = 0.0
        for _ in range(windows):
            full, start = self._window()
            loss, _, u = self._grad(full, start, True)
            total += loss
            for L in self.layers:
                acc[str(L)] = acc[str(L)] + u[str(L)]
            mx.eval(list(acc.values()))
        scores = []
        for L in self.layers:
            # d loss / d dose for every neuron of L; resid unit is already in u
            s = mx.abs(self.cols[L].T @ (acc[str(L)] / windows))
            mx.eval(s)
            scores.append(s)
        have = set(self.support)
        cand = []
        for L, s in zip(self.layers, scores):
            top = mx.argsort(-s)[: m * 3].tolist()
            cand += [(s[n].item(), L, n) for n in top if (L, n) not in have]
        cand.sort(reverse=True)
        chosen = [(L, n) for _, L, n in cand[:m]]
        self.support += chosen
        self.doses = mx.concatenate([self.doses, mx.zeros((len(chosen),), dtype=mx.float32)])
        return total / windows, chosen

    def polish(self, steps, batch, lr, radius):
        opt = optim.Adam(learning_rate=lr)
        state = {"doses": self.doses}
        last = 0.0
        for _ in range(steps):
            acc, total = 0, 0.0
            for _ in range(batch):
                full, start = self._window()
                self.doses = state["doses"]
                loss, g, _ = self._grad(full, start, False)
                acc = acc + g
                total += loss
            opt.update(state, {"doses": acc / batch})
            nrm = mx.linalg.norm(state["doses"]).item()
            if nrm > radius:
                state["doses"] = state["doses"] * (radius / nrm)
            mx.eval(state)
            last = total / batch
        self.doses = state["doses"]
        return last

    def recipe(self, scale=1.0):
        ds = self.doses.tolist()
        return [{"layer": L, "neuron": n, "mode": "dose", "value": round(d * scale, 4)} for (L, n), d in zip(self.support, ds)]


def grow(lab, theme, layers, k_max=64, per_round=4, radius=0.8, seed=0, out=None, log=print, examples=None, polish_steps=4, select_windows=10, final_polish=10, snaps=(8, 16, 32, 64, 128, 256)):
    s = Sparse(lab, theme, layers, seed=seed, examples=examples)
    t0 = time.time()
    snapshots = {}
    while len(s.support) < k_max:
        loss0, chosen = s.add_neurons(per_round, select_windows)
        loss1 = s.polish(polish_steps, 5, 0.02, radius)
        k = len(s.support)
        log(f"  k={k} loss {loss0:.3f}->{loss1:.3f} |d| {mx.linalg.norm(s.doses).item():.3f} {time.time() - t0:.0f}s last {chosen[0]}")
        if k in snaps or k >= k_max:
            s.polish(final_polish, 5, 0.01, radius)
            snapshots[k] = s.recipe()
            if out:
                with open(out, "a") as f:
                    f.write(json.dumps({"theme": theme, "layers": layers, "k": k, "radius": radius, "seed": seed, "pushes": snapshots[k]}) + "\n")
    return snapshots


if __name__ == "__main__":
    theme = sys.argv[1]
    layers = [int(x) for x in sys.argv[2].split(",")]
    k_max = int(sys.argv[3]) if len(sys.argv) > 3 else 64
    radius = float(sys.argv[4]) if len(sys.argv) > 4 else 0.8
    lab = PLab(MODEL_4B)
    out = os.path.join(CACHE, "gd_sparse.jsonl")
    snaps = grow(lab, theme, layers, k_max=k_max, radius=radius, out=out)
    for k, p in snaps.items():
        print(k, format_recipe(p)[:400])
    print(mx.get_peak_memory() / 1e9, "GB peak")

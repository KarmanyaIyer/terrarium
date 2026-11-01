"""Checks scan_lens's tail run against a full steered forward, and times a batch."""
import time

import mlx.core as mx

from common import MODEL_4B
from plab import PLab
from scan_lens import CONTEXTS, base_states, tail

lab = PLab(MODEL_4B)
states = base_states(lab)
L, n = 22, 2742
w = lab._down_weight(L)
col = w[:, n] / lab.down_norm[L][n]
ids = lab.chat_ids(*[CONTEXTS[0][0]], prefill=CONTEXTS[0][1])
lab.apply_mix([{"layer": L, "neuron": n, "mode": "dose", "value": 0.5}])
full, _ = lab.forward(ids, capture=None)
lab.clear()
lf = full[-1].astype(mx.float32)
lf = lf - mx.logsumexp(lf)
h = states[0][0][L] + (col * 0.5 * lab.resid[L]).astype(states[0][0][L].dtype)
lt = tail(lab, h, L)[0]
print("max abs diff", mx.abs(lf - lt).max().item(), "top", lab.tok.decode([mx.argmax(lf).item()]), lab.tok.decode([mx.argmax(lt).item()]))
print("unsteered top", lab.tok.decode([mx.argmax(states[0][1]).item()]))
cols = (w / lab.down_norm[L][None, :]).T
for B in (32, 96, 192):
    t = time.time()
    h = states[0][0][L] + (cols[:B][:, None, :] * 0.5 * lab.resid[L]).astype(states[0][0][L].dtype)
    lp = tail(lab, h, L)
    mx.eval(lp)
    print(B, f"{time.time() - t:.3f}s", f"peak {mx.get_peak_memory() / 1e9:.2f}GB")
L = 4
cols = (lab._down_weight(L) / lab.down_norm[L][None, :]).T
t = time.time()
h = states[0][0][L] + (cols[:96][:, None, :] * 0.5 * lab.resid[L]).astype(states[0][0][L].dtype)
lp = tail(lab, h, L)
mx.eval(lp)
print("L4 B96", f"{time.time() - t:.3f}s")

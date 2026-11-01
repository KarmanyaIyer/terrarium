"""Turns a residual vector into a neuron recipe. One neuron at dose d pushes the residual by d * resid * (unit down_proj column),
so with the vector in resid units, sparse coding it over the unit columns gives doses directly (orthogonal matching pursuit)."""

import mlx.core as mx
import numpy as np


def unit_columns(lab, L):
    w = lab._down_weight(L)
    d = np.array(w / mx.maximum(lab.down_norm[L], 1e-6)[None, :])  # [d, N]
    return d


def omp(D, u, k):
    """Greedy sparse code of u over unit columns D. Returns (indices, coefs, cosine with u)."""
    r = u.copy()
    idx = []
    coef = None
    for _ in range(k):
        c = D.T @ r
        c[idx] = 0
        idx.append(int(np.argmax(np.abs(c))))
        A = D[:, idx]
        coef, *_ = np.linalg.lstsq(A, u, rcond=None)
        r = u - A @ coef
    fit = u - r
    cos = float(fit @ u / max(np.linalg.norm(fit) * np.linalg.norm(u), 1e-9))
    return idx, coef, cos


def recipe_from_vector(lab, vec, k, scale=1.0, cols=None):
    """vec: {layer: [d] array in resid units}. k neurons per layer. Returns (pushes, {layer: cosine})."""
    pushes, cosines = [], {}
    for L, u in vec.items():
        D = cols[L] if cols and L in cols else unit_columns(lab, L)
        idx, coef, cos = omp(D, np.array(u.astype(mx.float32)), k)
        cosines[L] = round(cos, 3)
        for n, c in zip(idx, coef):
            pushes.append({"layer": L, "neuron": int(n), "mode": "dose", "value": round(float(c) * scale, 4)})
    return pushes, cosines

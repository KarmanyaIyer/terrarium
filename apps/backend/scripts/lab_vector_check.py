"""Checks a vector's math on a model dir, for src/lab/sidecar.test.ts: what apply_mix makes the hook add, at every
position, against the projection without it. usage: lab_vector_check.py <model_dir>. Prints "ok" or exits non-zero.
"""

import os
import sys

import mlx.core as mx

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lab_core import Lab, encode_vector  # noqa: E402


def main() -> None:
    lab = Lab(sys.argv[1], os.path.join(os.path.dirname(sys.argv[1]), "lab-check"))
    d = lab.d_model
    layer = 1
    u = mx.random.normal((d,), key=mx.random.key(0)).astype(mx.float32)
    u = u / mx.linalg.norm(u)
    text = encode_vector(u)
    down = lab.downs[layer]  # the wrapped projection
    x = mx.random.normal((1, 5, lab.n_neurons[layer]), key=mx.random.key(1)).astype(mx.float16)

    base = down.inner(x)
    entry = {"kind": "vector", "id": "v", "name": "v", "layer": layer, "strength": 1.5, "u": text}

    lab.apply_mix([entry])
    got = down(x)
    want = base + (1.5 * lab.resid[layer] * u).astype(base.dtype)
    assert mx.abs(got - want).max().item() < 1e-2, "strength * resid * u at every position"

    lab.apply_mix([entry], scale=2.0)
    assert mx.abs(down(x) - (base + (3.0 * lab.resid[layer] * u).astype(base.dtype))).max().item() < 1e-2, "scale multiplies strength"

    lab.apply_mix([entry, {**entry, "id": "w", "strength": -0.5}])
    assert mx.abs(down(x) - (base + (1.0 * lab.resid[layer] * u).astype(base.dtype))).max().item() < 1e-2, "two on a layer add"

    lab.apply_mix([entry, {"layer": layer, "neuron": 2, "mode": "dose", "value": 1.0}])
    both = down(x)
    lab.apply_mix([{"layer": layer, "neuron": 2, "mode": "dose", "value": 1.0}])
    neuron = down(x)
    assert mx.abs(both - (neuron + (1.5 * lab.resid[layer] * u).astype(base.dtype))).max().item() < 1e-2, "neuron and vector act together"

    lab.clear()
    assert mx.abs(down(x) - base).max().item() == 0, "clear removes it"
    print("ok")


if __name__ == "__main__":
    main()

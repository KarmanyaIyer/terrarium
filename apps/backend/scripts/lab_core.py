"""Neuron Lab core: read, steer and take gradients of MLP neurons in an mlx-lm model.

Ported from the user's earlier neuron_lab (_scratch27 fb7c359: src/neuron_lab/lab.py and scripts 01-04, the owl
neuron on Qwen3-8B). A neuron is one entry of layer L's MLP hidden activation, act(gate(x)) * up(x), which is the
input to the projection back into the residual stream: L15N4041 = layer 15, index 4041. Hooks wrap that projection, so
they work for any gated MLP listed in MLP_SHAPES (SwiGLU in Qwen3.5 and LFM3, GeGLU in Gemma 4).

Dose unit (neuronary.org / neuron-explorer): dose d adds d * median(|residual leaving layer L|) / |W_down[:, n]| to
the activation, at every position. The push on the residual stream is then d times its typical size.
"""

import hashlib
import json
import math
import os
import random
import re
import time

import mlx.core as mx
import mlx.nn as nn
from mlx_lm.generate import stream_generate
from mlx_lm.models.cache import make_prompt_cache
from mlx_lm.sample_utils import make_logits_processors, make_sampler
from mlx_lm.utils import load as load_model
from mlx_lm.utils import load_tokenizer

from lab_corpus import CORPUS_VERSION, FIELD_GUIDE, calibration_texts


# Probe captures every neuron at every token (about 1 MB per token on Qwen3.5-4B), so long texts are capped. The
# backend's memory estimate (lab/support.ts) assumes this cap plus a 256-token reply.
PROBE_MAX_TOKENS = 1024


# Where a layer keeps its gated MLP: (attribute on the layer, projection out of the neurons, projections into them).
# Mirrored in the backend's lab/support.ts. LFM3's feed_forward.w2(swiglu(w1, w3)) is mlp.down_proj(gate * up) renamed.
MLP_SHAPES = [("mlp", "down_proj", ("gate_proj", "up_proj")), ("feed_forward", "w2", ("w1", "w3"))]


def mlp_parts(layer) -> tuple | None:
    """(the MLP module, name of its projection out of the neurons, a projection into them), or None."""
    for holder, down, ins in MLP_SHAPES:
        mlp = getattr(layer, holder, None)
        gate = next((m for m in (getattr(mlp, n, None) for n in ins) if m is not None), None)
        if mlp is not None and gate is not None and getattr(mlp, down, None) is not None:
            return mlp, down, gate
    return None


class LabError(Exception):
    """A request the Lab can't serve; the message is shown to the user."""


class LabCancelled(LabError):
    """The caller cancelled while this op ran."""


def unsupported_reason(config: dict) -> str | None:
    """Why single-neuron hooks don't apply to this model dir, or None. Mirrored in the backend's lab/support.ts."""
    t = config.get("text_config", config)
    if (t.get("num_experts") or 0) > 0 or t.get("enable_moe_block"):
        return "Mixture-of-experts MLP: neurons live inside experts, which the Lab does not hook"
    return None


# ---------- hooks ----------


class Hook:
    """Per-layer intervention and capture state, read by HookedDown on every forward pass."""

    def __init__(self, n: int):
        self.n = n
        self.clamp_mask: mx.array | None = None  # [N] 1 where clamped
        self.clamp_val: mx.array | None = None  # [N] clamp values, 0 elsewhere
        self.add: mx.array | None = None  # [N] added to the activation
        self.delta: mx.array | None = None  # [1, T, N] zeros to differentiate against
        self.capture: str | None = None  # None | "full" | "max" (max over positions >= 1)
        self.captured: list = []


class HookedDown(nn.Module):
    """down_proj with the neuron hooks applied to its input."""

    def __init__(self, inner: nn.Module, hook: Hook):
        super().__init__()
        self.inner = inner
        self.hook = hook  # plain attribute: not a parameter

    def __call__(self, x):
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
        return self.inner(x)


_RESID: dict[int, list] = {}  # id(decoder layer) -> outputs, while calibrating


def _patch_layer_class(cls) -> None:
    if getattr(cls, "_lab_patched", False):
        return
    orig = cls.__call__

    def call(self, *args, **kwargs):
        out = orig(self, *args, **kwargs)
        rec = _RESID.get(id(self))
        if rec is not None:
            rec.append(out[0] if isinstance(out, tuple) else out)
        return out

    cls.__call__ = call
    cls._lab_patched = True


def _dir_key(model_dir: str) -> str:
    h = hashlib.sha256()
    for name in sorted(os.listdir(model_dir)):
        p = os.path.join(model_dir, name)
        if os.path.isfile(p) and (name.endswith(".safetensors") or name == "config.json"):
            st = os.stat(p)
            h.update(f"{name}:{st.st_size}:{int(st.st_mtime)}".encode())
    h.update(f"corpus:{CORPUS_VERSION}".encode())
    return h.hexdigest()[:16]


def repetition(ids: list[int]) -> float:
    """Share of the reply's token 3-grams that repeat an earlier one."""
    grams = [tuple(ids[i : i + 3]) for i in range(len(ids) - 2)]
    if not grams:
        return 0.0
    return round(1 - len(set(grams)) / len(grams), 4)


def is_loop(ids: list[int]) -> bool:
    """The reply is stuck: a third of its 3-grams repeat, or its last 16 tokens cycle with a period of 8 or less."""
    if repetition(ids) > 0.3:
        return True
    tail = ids[-16:]
    if len(tail) < 16:
        return False
    return any(all(tail[i] == tail[i - p] for i in range(p, len(tail))) for p in range(1, 9))


def quality(ids: list[int], fluency: float, finish: str) -> str:
    """One word for how a reply reads. ok: ordinary text, however unexpected its content. odd: the unsteered model finds
    it unlikely word by word, which steering toward a new topic often does. loop: stuck repeating. broken: word salad.
    empty: stopped at once. Thresholds from labelled sweeps on Qwen3.5-4B and LFM3-1.7B, in TODO_25.md."""
    if not ids:
        return "empty"
    if is_loop(ids):
        return "loop"
    if fluency < QUALITY_BROKEN:
        return "broken"
    return "odd" if fluency < QUALITY_ODD else "ok"


SWEEP_MAX_DOSES = 512
QUALITY_ODD = -3.0
QUALITY_BROKEN = -5.0


def best_dose(measured: list[dict], base: float, target: int) -> dict:
    """The dose to recommend from measured interventions: the smallest that makes the target the model's pick, else the
    one that moved logit(target) - logit(foil) most in the target's favor. measured: {dose, metric, topId, ...}."""
    flips = [m for m in measured if m["topId"] == target]
    if flips:
        best = min(flips, key=lambda m: (abs(m["dose"]), -m["metric"]))
    else:
        best = max(measured, key=lambda m: m["metric"])
    return {**best, "change": round(best["metric"] - base, 3), "flips": best["topId"] == target}


class HadamardProjection(nn.Module):
    """A Bonsai pack's 2-bit projection. Its weights are stored rotated along their input axis, so it rotates its input
    (signs, then a Walsh-Hadamard transform per block) before the quantized multiply. down_proj's input is still the
    plain neuron vector: the rotation happens inside, after the hooks. Same arithmetic as the pack's runtime/runtime.py,
    written here so loading a model dir doesn't run code from it."""

    def __init__(self, weight, scales, biases, signs, block: int, embedding: bool):
        super().__init__()
        self.weight, self.scales, self.biases = weight, scales, biases
        if signs is not None:
            self.signs = signs
        self.block = block
        self.embedding = embedding
        self._dense_h = None

    def _walsh(self, x: mx.array) -> mx.array:
        """Normalized Hadamard transform per block. Plain matmul in training mode: the fast op has no backward pass."""
        shape = x.shape
        flat = x.reshape(-1, self.block)
        if self.training:
            if self._dense_h is None:
                self._dense_h = mx.hadamard_transform(mx.eye(self.block), scale=1 / math.sqrt(self.block))
            return (flat @ self._dense_h).reshape(shape)
        return mx.hadamard_transform(flat, scale=1 / math.sqrt(self.block)).reshape(shape)

    def _rotate(self, x: mx.array) -> mx.array:
        return self._walsh(x.astype(mx.float32) * self.signs).astype(x.dtype) if self.block else x

    def _unrotate(self, x: mx.array) -> mx.array:
        return (self._walsh(x.astype(mx.float32)) * self.signs).astype(x.dtype) if self.block else x

    def as_linear(self, x: mx.array) -> mx.array:
        y = mx.quantized_matmul(self._rotate(x), self.weight, self.scales, self.biases, transpose=True, group_size=128, bits=2)
        return y.astype(x.dtype) if y.dtype != x.dtype else y

    def __call__(self, x: mx.array) -> mx.array:
        if not self.embedding:
            return self.as_linear(x)
        i = x.reshape(-1)
        out = mx.dequantize(self.weight[i], self.scales[i], self.biases[i], group_size=128, bits=2)
        return self._unrotate(out.reshape(*x.shape, -1).astype(mx.float16))

    def dense(self) -> mx.array:
        """The unrotated weight matrix, [outputs, inputs], float32."""
        w = mx.dequantize(self.weight, self.scales, self.biases, group_size=128, bits=2).astype(mx.float32)
        return self._unrotate(w) if self.block else w


def load_hadamard_pack(model_dir: str, config: dict):
    """A Bonsai pack (model_type prism_hadamard_qwen35): mlx-lm's Qwen3.5 text model with the pack's rotated projections
    installed. The vision tower in the same file isn't loaded."""
    from pathlib import Path

    from mlx_lm.models.qwen3_5 import TextModel, TextModelArgs

    model = TextModel(TextModelArgs.from_dict(config["text_config"]))
    weights = {k.removeprefix("language_model."): v for k, v in mx.load(os.path.join(model_dir, "model.safetensors")).items() if k.startswith("language_model.")}
    for rec in config["modules"]:
        parts = rec["path"].split(".")
        parent = model
        for part in parts[:-1]:
            parent = parent[int(part)] if part.isdigit() else getattr(parent, part)
        name = rec["path"]
        setattr(parent, parts[-1], HadamardProjection(weights[f"{name}.weight"], weights[f"{name}.scales"], weights[f"{name}.biases"], weights.get(f"{name}.signs"), int(rec["block"]), bool(rec["embedding"])))
    model.load_weights(list(weights.items()), strict=True)
    model.eval()
    mx.eval(model.parameters())
    eos = []
    gen = os.path.join(model_dir, "generation_config.json")
    if os.path.exists(gen):
        with open(gen) as f:
            e = json.load(f).get("eos_token_id")
        eos = e if isinstance(e, list) else ([e] if e is not None else [])
    return model, load_tokenizer(Path(model_dir), eos_token_ids=eos or None)


def _sdpa_ops(queries, keys, values, scale, mask=None, sinks=None, **_):
    """Attention in plain ops, for gradients: MLX's single-query (vector) kernel has no backward pass."""
    hq, hkv = queries.shape[1], keys.shape[1]
    if hq != hkv:
        keys, values = mx.repeat(keys, hq // hkv, axis=1), mx.repeat(values, hq // hkv, axis=1)
    s = (queries * scale) @ keys.swapaxes(-1, -2)  # [B, H, L, S]
    L, S = s.shape[-2], s.shape[-1]
    if isinstance(mask, str):  # "causal"
        allowed = mx.arange(S - L, S)[:, None] >= mx.arange(S)[None]
        s = mx.where(allowed, s, mx.array(-mx.inf, s.dtype))
    elif mask is not None:
        s = mx.where(mask, s, mx.array(-mx.inf, s.dtype)) if mask.dtype == mx.bool_ else s + mask
    s = s.astype(mx.float32)
    if sinks is not None:
        sk = mx.broadcast_to(sinks.astype(mx.float32)[None, :, None, None], (*s.shape[:-1], 1))
        p = mx.softmax(mx.concatenate([sk, s], axis=-1), axis=-1)[..., 1:]
    else:
        p = mx.softmax(s, axis=-1)
    return p.astype(values.dtype) @ values


class Lab:
    def __init__(self, model_dir: str, cache_dir: str | None = None, log=print, progress=None):
        t0 = time.time()
        self.model_dir = model_dir
        self.model_id = os.path.basename(model_dir.rstrip("/"))
        with open(os.path.join(model_dir, "config.json")) as f:
            self.config = json.load(f)
        reason = unsupported_reason(self.config)
        if reason:
            raise LabError(reason)
        self.log = log
        self.progress = progress or (lambda stage, frac: None)
        self.progress("weights", 0.0)
        if "hadamard" in str(self.config.get("model_type", "")):
            self.model, self.tok = load_hadamard_pack(model_dir, self.config)
        else:
            # False, not the default: some configs carry an auto_map, and with None transformers stops to ask on stdin
            self.model, self.tok = load_model(model_dir, tokenizer_config={"trust_remote_code": False})
        self.model.eval()
        self.lm = getattr(self.model, "language_model", self.model)
        self.inner = self.lm.model
        self.layers = list(self.model.layers)
        self.n_layers = len(self.layers)
        tc = self.config.get("text_config", self.config)
        self.arch = str(tc.get("model_type") or self.config.get("model_type"))
        self.hooks: list[Hook] = []
        self.n_neurons: list[int] = []
        self.downs: list[HookedDown] = []
        for i, layer in enumerate(self.layers):
            parts = mlp_parts(layer)
            if parts is None:
                raise LabError(f"layer {i} has no gated MLP the Lab knows how to hook (looked for {', '.join(f'{h}.{d}' for h, d, _ in MLP_SHAPES)})")
            mlp, down_name, gate = parts
            down = getattr(mlp, down_name)
            if isinstance(down, HookedDown):
                down = down.inner
            n = int(gate.weight.shape[0])
            hook = Hook(n)
            wrapped = HookedDown(down, hook)
            setattr(mlp, down_name, wrapped)
            self.downs.append(wrapped)
            self.hooks.append(hook)
            self.n_neurons.append(n)
            _patch_layer_class(type(layer))
        self.d_model = int(tc.get("hidden_size", 0))
        act = str(tc.get("hidden_activation") or tc.get("hidden_act") or "silu")
        self.activation = "geglu" if "gelu" in act else "swiglu"
        q = self.config.get("quantization") or {}
        self.quant = f"{q['bits']}bit" if isinstance(q, dict) and q.get("bits") else "bf16"
        self.layer_kinds = self._layer_kinds(tc)
        self.nl_id = self.tok.encode("\n", add_special_tokens=False)[-1]
        self.final_norm = getattr(self.inner, "norm", None) or getattr(self.inner, "embedding_norm")
        self.strains: dict[str, list] = {}
        self.cancelled = False  # set from another thread: generation stops at its next token
        self.progress("down_proj", 0.5)
        # One layer at a time: evaluated together, every layer's dequantized W_down would be alive at once.
        self.down_norm = []
        for i in range(self.n_layers):
            self.down_norm.append(self._down_weight(i).square().sum(axis=0).sqrt())
            mx.eval(self.down_norm[-1])
        self._calibrate(cache_dir)
        self.load_ms = int((time.time() - t0) * 1000)
        self.progress("ready", 1.0)

    # ---------- facts ----------

    def _layer_kinds(self, tc: dict) -> list[str] | None:
        kinds = []
        for layer in self.layers:
            if hasattr(layer, "is_linear"):
                kinds.append("linear" if layer.is_linear else "full")
        if kinds:
            return kinds
        types = tc.get("layer_types")
        if isinstance(types, list) and len(types) == self.n_layers:
            return ["sliding" if "sliding" in str(t) else "conv" if "conv" in str(t) else "full" for t in types]
        return None

    def facts(self) -> dict:
        return {
            "modelId": self.model_id,
            "arch": self.arch,
            "layers": self.n_layers,
            "neuronsPerLayer": self.n_neurons,
            "totalNeurons": sum(self.n_neurons),
            "dModel": self.d_model,
            "activation": self.activation,
            "quant": self.quant,
            **({"layerKinds": self.layer_kinds} if self.layer_kinds else {}),
            "residNorm": [round(x, 3) for x in self.resid],
            "calibrationTokens": self.calib_tokens,
            "residentBytes": int(mx.get_active_memory()),
            "loadMs": self.load_ms,
        }

    # ---------- interventions ----------

    def clear(self) -> None:
        for h in self.hooks:
            h.clamp_mask = h.clamp_val = h.add = h.delta = None
            h.capture = None
            h.captured = []

    def check_ref(self, layer, neuron) -> tuple[int, int]:
        if not isinstance(layer, int) or not isinstance(neuron, int) or isinstance(layer, bool) or isinstance(neuron, bool):
            raise LabError("layer and neuron must be integers")
        if not 0 <= layer < self.n_layers:
            raise LabError(f"layer {layer} out of range: this model has layers 0 to {self.n_layers - 1}")
        if not 0 <= neuron < self.n_neurons[layer]:
            raise LabError(f"neuron {neuron} out of range: layer {layer} has neurons 0 to {self.n_neurons[layer] - 1}")
        return layer, neuron

    def dose_unit(self, layer: int, neuron: int) -> float:
        return float(self.resid[layer] / max(self.down_norm[layer][neuron].item(), 1e-6))

    def check_mix(self, pushes: list | None) -> None:
        """Validates pushes against this model without touching the hooks, so it is safe while another op runs."""
        if not isinstance(pushes, (list, type(None))):
            raise LabError("pushes must be a list")
        for p in pushes or []:
            if not isinstance(p, dict):
                raise LabError("each push must be an object")
            layer, n = self.check_ref(p.get("layer"), p.get("neuron"))
            v = p.get("value")
            if not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v):
                raise LabError(f"L{layer}N{n}: value must be a number")
            if p.get("mode", "dose") not in ("dose", "clamp"):
                raise LabError(f"L{layer}N{n}: mode must be dose or clamp")

    def apply_mix(self, pushes: list | None, scale: float = 1.0) -> None:
        """pushes: [{layer, neuron, mode: dose|clamp, value}]. Clears previous interventions first."""
        self.clear()
        self.check_mix(pushes)
        for p in pushes or []:
            layer, n, mode, v = p["layer"], p["neuron"], p.get("mode", "dose"), p["value"]
            h = self.hooks[layer]
            one = mx.zeros((h.n,), dtype=mx.float32).at[n].add(1.0)
            if mode == "clamp":
                h.clamp_mask = one if h.clamp_mask is None else mx.maximum(h.clamp_mask, one)
                prev = h.clamp_val if h.clamp_val is not None else mx.zeros((h.n,), dtype=mx.float32)
                h.clamp_val = prev * (1 - one) + one * float(v)
            else:
                prev = h.add if h.add is not None else mx.zeros((h.n,), dtype=mx.float32)
                h.add = prev + one * (float(v) * scale * self.dose_unit(layer, n))

    # ---------- weights ----------

    def _down_weight(self, i: int) -> mx.array:
        """Dequantized weight of the projection out of the neurons, [d_model, N], for layer i (float32)."""
        d = self.hooks_down(i)
        if isinstance(d, HadamardProjection):
            return d.dense()
        if hasattr(d, "scales"):
            kw = {"mode": d.mode} if hasattr(d, "mode") else {}
            w = mx.dequantize(d.weight, d.scales, getattr(d, "biases", None), d.group_size, d.bits, **kw)
        else:
            w = d.weight
        return w.astype(mx.float32)

    def hooks_down(self, i: int):
        return self.downs[i].inner

    def _unembed(self, h: mx.array) -> mx.array:
        if hasattr(self.lm, "lm_head") and not getattr(getattr(self.lm, "args", None), "tie_word_embeddings", False):
            return self.lm.lm_head(h).astype(mx.float32)
        return self.inner.embed_tokens.as_linear(h).astype(mx.float32)

    def vocab_projection(self, refs: list[tuple[int, int]], k: int = 8) -> list[tuple[list, list]]:
        """Tokens each neuron's down_proj column pushes up and down when read straight out through the final norm."""
        out: list = [None] * len(refs)
        by_layer: dict[int, list[int]] = {}
        for idx, (layer, _) in enumerate(refs):
            by_layer.setdefault(layer, []).append(idx)
        for layer, idxs in by_layer.items():
            w = self._down_weight(layer)
            cols = mx.stack([w[:, refs[i][1]] for i in idxs])  # [k, d]
            logits = self._unembed(self.final_norm(cols.astype(mx.float16)))
            top = mx.argsort(-logits, axis=-1)[:, :k]
            bot = mx.argsort(logits, axis=-1)[:, :k]
            mx.eval(top, bot, logits)
            for j, i in enumerate(idxs):
                up = [(self.tok.decode([t]), round(logits[j, t].item(), 2)) for t in top[j].tolist()]
                down = [(self.tok.decode([t]), round(logits[j, t].item(), 2)) for t in bot[j].tolist()]
                out[i] = (up, down)
            del w
        return out

    # ---------- encoding ----------

    def encode_text(self, text: str) -> list[int]:
        """Plain text with a leading newline token, so the first real token isn't the attention sink at position 0."""
        return [self.nl_id] + self.tok.encode(text, add_special_tokens=False)

    def render_chat(self, messages: list[dict], tools=None, **template_kwargs) -> str:
        kw = {"tokenize": False, "add_generation_prompt": True, **template_kwargs}
        if tools:
            kw["tools"] = tools
        try:
            return self.tok.apply_chat_template(messages, **kw)
        except TypeError:
            for key in template_kwargs:
                kw.pop(key, None)
            kw.pop("tools", None)
            return self.tok.apply_chat_template(messages, **kw)

    def chat_ids(self, user: str, system: str | None = None, thinking: bool = False, prefill: str = "") -> list[int]:
        msgs = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": user}]
        prompt = self.render_chat(msgs, enable_thinking=thinking)
        return self.tok.encode(prompt + prefill, add_special_tokens=False)

    def decode_each(self, ids: list[int]) -> list[str]:
        return [self.tok.decode([t]) for t in ids]

    # ---------- forward passes ----------

    def forward(self, ids: list[int], capture: str | None = "full", layers=None, logits: bool = True):
        """One forward pass with the current mix. Returns (logits [T, V] or None, {layer: captured}). logits=False
        skips the unembedding, the biggest array of a long pass (1800 tokens x 248k vocab is 0.9 GB)."""
        layers = range(self.n_layers) if layers is None else layers
        for i in layers:
            self.hooks[i].capture = capture
            self.hooks[i].captured = []
        try:
            x = mx.array(ids)[None]
            y = self.model(x) if logits else self.inner(x)
            out = {i: self.hooks[i].captured[0][0] for i in layers} if capture else {}
            mx.eval(y, *out.values())
        finally:
            for i in layers:
                self.hooks[i].capture = None
                self.hooks[i].captured = []
        return (y[0] if logits else None), out

    # ---------- calibration: typical ranges and dose scale ----------

    def _calibrate(self, cache_dir: str | None) -> None:
        key = _dir_key(self.model_dir)
        path = os.path.join(cache_dir, f"{self.model_id}.calib.safetensors") if cache_dir else None
        if path and os.path.exists(path):
            try:
                data, meta = mx.load(path, return_metadata=True)
                # mx.load is lazy on this thread's CPU stream; request threads can't evaluate it later
                mx.eval(list(data.values()))
                if meta.get("key") == key:
                    self._set_calibration(data, int(meta["tokens"]))
                    self.log(f"calibration loaded from {path}")
                    return
            except Exception as err:  # corrupt cache: recompute
                self.log(f"calibration cache unreadable ({err}); recomputing")
        t0 = time.time()
        texts = [self.encode_text(t) for t in calibration_texts()]
        total = sum(len(t) - 1 for t in texts)
        k = max(1, math.ceil(0.01 * total))
        L = self.n_layers
        s1 = [mx.zeros((n,), dtype=mx.float32) for n in self.n_neurons]
        s2 = [mx.zeros((n,), dtype=mx.float32) for n in self.n_neurons]
        hi = [mx.full((n,), -1e9, dtype=mx.float32) for n in self.n_neurons]
        lo = [mx.full((n,), 1e9, dtype=mx.float32) for n in self.n_neurons]
        top = [mx.zeros((n, 0), dtype=mx.float32) for n in self.n_neurons]
        resid: list[list] = [[] for _ in range(L)]
        self.clear()
        for ti, ids in enumerate(texts):
            for layer in self.layers:
                _RESID[id(layer)] = []
            try:
                _, acts = self.forward(ids, logits=False)
                outs = [_RESID[id(layer)][0] for layer in self.layers]
            finally:
                for layer in self.layers:
                    _RESID.pop(id(layer), None)
            for i in range(L):
                a = acts[i][1:].astype(mx.float32)  # [T-1, N]
                s1[i] = s1[i] + a.sum(axis=0)
                s2[i] = s2[i] + (a * a).sum(axis=0)
                hi[i] = mx.maximum(hi[i], a.max(axis=0))
                lo[i] = mx.minimum(lo[i], a.min(axis=0))
                both = mx.concatenate([top[i], mx.abs(a).T], axis=1)
                top[i] = mx.topk(both, min(k, both.shape[1]), axis=-1)
                resid[i].append(mx.sqrt((outs[i][0, 1:].astype(mx.float32) ** 2).sum(axis=-1)))
            mx.eval(s1, s2, hi, lo, top, *[r[-1] for r in resid])
            self.progress("calibration", 0.5 + 0.5 * (ti + 1) / len(texts))
        data = {}
        for i in range(L):
            mean = s1[i] / total
            data[f"mean.{i}"] = mean
            data[f"std.{i}"] = mx.sqrt(mx.maximum(s2[i] / total - mean * mean, 0))
            data[f"max.{i}"] = hi[i]
            data[f"min.{i}"] = lo[i]
            data[f"p99.{i}"] = top[i].min(axis=-1)
            r = mx.sort(mx.concatenate(resid[i]))
            data[f"resid.{i}"] = r[r.shape[0] // 2 : r.shape[0] // 2 + 1]
        mx.eval(data)
        if path:
            os.makedirs(cache_dir, exist_ok=True)
            mx.save_safetensors(path, data, metadata={"key": key, "tokens": str(total)})
        self._set_calibration(data, total)
        self.log(f"calibrated on {total} tokens in {time.time() - t0:.1f}s")

    def _set_calibration(self, data: dict, tokens: int) -> None:
        L = self.n_layers
        self.calib_tokens = tokens
        self.stats = {k: [data[f"{k}.{i}"] for i in range(L)] for k in ("mean", "std", "max", "min", "p99")}
        self.resid = [float(data[f"resid.{i}"].item()) for i in range(L)]
        # Typical peak, floored so that neurons silent on ordinary text don't produce huge ratios from noise.
        self.typ = []
        for i in range(L):
            p = self.stats["p99"][i]
            floor = max(1e-3, 0.25 * mx.sort(p)[p.shape[0] // 2].item())
            self.typ.append(mx.maximum(p, floor))
        mx.eval(self.typ)

    # ---------- probe ----------

    def probe(self, req: dict) -> dict:
        t0 = time.time()
        text = str(req.get("text", ""))
        if not text.strip():
            raise LabError("text is empty")
        chat = bool(req.get("chat"))
        kinds: list[str] = []
        if chat:
            ids = self.chat_ids(text, thinking=bool(req.get("thinking")))
            kinds = self._mark_text(ids, text)
        else:
            ids = self.encode_text(text)
            kinds = ["template"] + ["text"] * (len(ids) - 1)
        if len(ids) > PROBE_MAX_TOKENS:
            raise LabError(f"text is {len(ids)} tokens; the probe takes at most {PROBE_MAX_TOKENS}")
        mix = req.get("mix") or []
        if chat and req.get("reply"):
            self.apply_mix(mix)
            room = max(1, min(int(req.get("maxTokens") or 80), 256, PROBE_MAX_TOKENS + 256 - len(ids)))
            reply, _ = self._generate(ids, temperature=0.0, max_tokens=room, seed=0)
            ids = ids + reply
            kinds = kinds + ["reply"] * len(reply)
        self.apply_mix(mix)
        try:
            _, acts = self.forward(ids, logits=False)
        finally:
            self.clear()
        T = len(ids)
        valid = mx.array([1.0 if (i > 0 and kinds[i] != "template") else 0.0 for i in range(T)])
        if valid.sum().item() == 0:
            valid = mx.array([0.0] + [1.0] * (T - 1)) if T > 1 else mx.ones((T,))
        tops = max(1, min(int(req.get("top") or 40), 200))
        best_v, best_i, best_at, per_v, per_i = [], [], [], [], []
        offset = 0
        offsets = []
        for i in range(self.n_layers):
            offsets.append(offset)
            rel = acts[i].astype(mx.float32) / self.typ[i]  # [T, N]
            masked = rel * valid[:, None] - (1 - valid[:, None]) * 1e9
            best_v.append(masked.max(axis=0))
            best_at.append(masked.argmax(axis=0))
            k = min(5, self.n_neurons[i])
            idx = mx.argpartition(-rel, k - 1, axis=-1)[:, :k]
            per_i.append(idx + offset)
            per_v.append(mx.take_along_axis(rel, idx, axis=-1))
            # Per layer: the [T, N] temporaries of every layer at once took 13 GB on an 1800-token text.
            mx.eval(best_v[-1], best_at[-1], per_i[-1], per_v[-1])
            offset += self.n_neurons[i]
        flat_v = mx.concatenate(best_v)
        flat_at = mx.concatenate(best_at)
        order = mx.argsort(-flat_v)[:tops].tolist()
        pv = mx.concatenate(per_v, axis=1)
        pi = mx.concatenate(per_i, axis=1)
        po = mx.argsort(-pv, axis=-1)[:, :5]
        pv = mx.take_along_axis(pv, po, axis=-1)
        pi = mx.take_along_axis(pi, po, axis=-1)
        mx.eval(flat_v, flat_at, pv, pi)
        locate = self._locator(offsets)
        top = []
        for f in order:
            layer, n = locate(f)
            at = int(flat_at[f].item())
            value = acts[layer][at, n].item()
            top.append({"layer": layer, "neuron": n, "value": round(value, 3), "at": at, "rel": round(flat_v[f].item(), 2), "typical": round(self.typ[layer][n].item(), 4)})
        per_token = []
        pv_l, pi_l = pv.tolist(), pi.tolist()
        for t in range(T):
            row = []
            for v, f in zip(pv_l[t], pi_l[t]):
                layer, n = locate(f)
                row.append({"layer": layer, "neuron": n, "rel": round(v, 2)})
            per_token.append(row)
        watch = []
        for w in req.get("watch") or []:
            if not isinstance(w, dict):
                raise LabError("each watch entry must be {layer, neuron}")
            layer, n = self.check_ref(w.get("layer"), w.get("neuron"))
            watch.append(self._trace(acts, layer, n))
        layer_view = None
        if req.get("layer") is not None:
            layer = req["layer"]
            self.check_ref(layer, 0)
            rel = acts[layer].astype(mx.float32) / self.typ[layer]
            m = (rel * valid[:, None] - (1 - valid[:, None]) * 1e9).max(axis=0)
            ns = mx.argsort(-m)[:16].tolist()
            layer_view = {"layer": layer, "traces": [self._trace(acts, layer, n) for n in ns]}
        tokens = [{"i": i, "id": t, "text": s, "kind": kinds[i]} for i, (t, s) in enumerate(zip(ids, self.decode_each(ids)))]
        out = {"tokens": tokens, "top": top, "perToken": per_token, "watch": watch, "ms": int((time.time() - t0) * 1000)}
        if layer_view:
            out["layer"] = layer_view
        return out

    def _locator(self, offsets: list[int]):
        def locate(f: int) -> tuple[int, int]:
            lo, hi = 0, len(offsets) - 1
            while lo < hi:
                mid = (lo + hi + 1) // 2
                if offsets[mid] <= f:
                    lo = mid
                else:
                    hi = mid - 1
            return lo, f - offsets[lo]

        return locate

    def _trace(self, acts, layer: int, n: int) -> dict:
        return {"ref": {"layer": layer, "neuron": n}, "values": [round(v, 3) for v in acts[layer][:, n].astype(mx.float32).tolist()], "typical": round(self.typ[layer][n].item(), 4)}

    def _mark_text(self, ids: list[int], text: str) -> list[str]:
        """template for chat markup, text for the user's own tokens (found as a run inside the prompt)."""
        kinds = ["template"] * len(ids)
        own = self.tok.encode(text, add_special_tokens=False)
        n = len(own)
        for s in range(len(ids) - n, -1, -1):
            if ids[s : s + n] == own:
                for i in range(s, s + n):
                    kinds[i] = "text"
                return kinds
        # Tokenized differently in context: mark the longest middle stretch that matches token by token.
        inner = own[1:-1]
        for s in range(len(ids) - len(inner), -1, -1):
            if inner and ids[s : s + len(inner)] == inner:
                for i in range(max(0, s - 1), min(len(ids), s + len(inner) + 1)):
                    kinds[i] = "text"
                break
        return kinds

    # ---------- find: concept vs control ----------

    # Contexts for the steering check: a chat question and the start of the answer, so the next token is open.
    WRITE_CONTEXTS = [("Who are you?", "I am"), ("Tell me a short story.", "Once upon a time, there was a"), ("What should I do this weekend?", "You could")]
    WRITE_DOSE = 0.8

    def concept_tokens(self, concept: list[str], control: list[str], cap: int = 24) -> list[int]:
        """Tokens that show up in several concept texts and in no control text (the concept's own words)."""
        def sets(texts):
            return [set(self.tok.encode(t, add_special_tokens=False)) | set(self.tok.encode(" " + t, add_special_tokens=False)) for t in texts]

        cs, ks = sets(concept), sets(control)
        banned = set().union(*ks) if ks else set()
        counts: dict[int, int] = {}
        for s in cs:
            for t in s - banned:
                counts[t] = counts.get(t, 0) + 1
        need = max(2, math.ceil(0.15 * len(concept)))
        keep = [t for t, n in sorted(counts.items(), key=lambda x: -x[1]) if n >= need and len(self.tok.decode([t]).strip()) >= 2]
        return keep[:cap]

    def _write_contexts(self) -> list[list[int]]:
        if not hasattr(self, "_wctx"):
            self._wctx = [self.chat_ids(q, prefill=p) for q, p in self.WRITE_CONTEXTS]
        return self._wctx

    def _next_logprobs(self) -> mx.array:
        """[contexts, vocab] next-token log-probs with the current mix."""
        rows = []
        for ids in self._write_contexts():
            logits, _ = self.forward(ids, capture=None)
            lg = logits[-1].astype(mx.float32)
            rows.append(lg - mx.logsumexp(lg))
        out = mx.stack(rows)
        mx.eval(out)
        return out

    def writes(self, refs: list[tuple[int, int]], tokens: list[int]) -> list[dict]:
        """Push each neuron by +0.8 and measure what the next token does: the log-probability mass gained by the concept
        tokens (nats, mean over a few contexts) and the tokens gained most (the steer lens)."""
        self.clear()
        base = self._next_logprobs()
        tok = mx.array(tokens) if tokens else None
        base_mass = mx.logsumexp(base[:, tok], axis=-1) if tok is not None else None
        out = []
        for layer, n in refs:
            self._check_cancel()
            self.apply_mix([{"layer": layer, "neuron": n, "mode": "dose", "value": self.WRITE_DOSE}])
            try:
                lp = self._next_logprobs()
            finally:
                self.clear()
            d = (lp - base).mean(axis=0)
            gained = mx.argsort(-d)[:6].tolist()
            delta = (mx.logsumexp(lp[:, tok], axis=-1) - base_mass).mean().item() if tok is not None else 0.0
            kl = (mx.exp(lp) * (lp - base)).sum(axis=-1).mean().item()
            out.append({"delta": round(delta, 3), "kl": round(kl, 3), "tokens": [self.tok.decode([t]) for t in gained]})
        return out

    def _direct_writers(self, tokens: list[int], layers: list[int], k: int) -> list[tuple[int, int]]:
        """Neurons whose down_proj column, read straight out through the final norm, favors the concept tokens most
        (relative to an average token). Cheap enough to scan every neuron."""
        if not tokens:
            return []
        w_eff = self.final_norm(mx.ones((self.d_model,), dtype=mx.float16)).astype(mx.float32)
        rows = self._unembed_rows(tokens)  # [k, d]
        sample = self._unembed_rows(list(range(0, self.tok.vocab_size, max(1, self.tok.vocab_size // 2048))))
        u = (rows.mean(axis=0) - sample.mean(axis=0)) * w_eff  # [d]
        scores = []
        for i in layers:
            w = self._down_weight(i)  # [d, N]
            s = (u[:, None] * w).sum(axis=0) / mx.maximum(self.down_norm[i], 1e-6)
            mx.eval(s)
            scores.append(s)
            del w
        flat = mx.concatenate(scores)
        order = mx.argsort(-flat)[:k].tolist()
        offsets, off = [], 0
        for i in layers:
            offsets.append(off)
            off += self.n_neurons[i]
        locate = self._locator(offsets)
        return [(layers[li], n) for li, n in (locate(f) for f in order)]

    def _unembed_rows(self, tokens: list[int]) -> mx.array:
        tied = not hasattr(self.lm, "lm_head") or getattr(getattr(self.lm, "args", None), "tie_word_embeddings", False)
        m = self.inner.embed_tokens if tied else self.lm.lm_head
        idx = mx.array(tokens)
        if isinstance(m, HadamardProjection):
            return m(idx).astype(mx.float32)
        if hasattr(m, "scales"):
            kw = {"mode": m.mode} if hasattr(m, "mode") else {}
            b = getattr(m, "biases", None)
            w = mx.dequantize(m.weight[idx], m.scales[idx], b[idx] if b is not None else None, m.group_size, m.bits, **kw)
        else:
            w = m.weight[idx]
        return w.astype(mx.float32)

    def find(self, req: dict) -> dict:
        t0 = time.time()
        concept = [str(t) for t in req.get("concept") or [] if str(t).strip()]
        control = [str(t) for t in req.get("control") or [] if str(t).strip()]
        if len(concept) < 2 or len(control) < 2:
            raise LabError("give at least 2 concept texts and 2 control texts")
        if len(concept) + len(control) > 200:
            raise LabError("at most 200 texts in total")
        span = req.get("layers") or [0, self.n_layers - 1]
        if not isinstance(span, list) or len(span) != 2 or not all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in span):
            raise LabError("layers must be [first, last]")
        lo, hi = max(0, int(span[0])), min(self.n_layers - 1, int(span[1]))
        if lo > hi:
            raise LabError(f"layers: first must be at most last, within 0 to {self.n_layers - 1}")
        layers = list(range(lo, hi + 1))
        typ = mx.concatenate([self.typ[i] for i in layers])
        self.clear()
        tokens = 0

        def peaks(texts):
            nonlocal tokens
            rows = []
            for t in texts:
                self._check_cancel()
                ids = self.encode_text(t)[:512]
                tokens += len(ids) - 1
                _, a = self.forward(ids, capture="max", layers=layers, logits=False)
                rows.append(mx.concatenate([a[i].astype(mx.float32) for i in layers]) / typ)
            return mx.stack(rows)  # [texts, sum N], in units of each neuron's typical peak

        c, k = peaks(concept), peaks(control)
        diff = c.mean(0) - k.mean(0)
        std = mx.sqrt((c.var(0) + k.var(0)) / 2) + 0.1
        score = diff / std
        wins = (c > k.max(0)[None]).astype(mx.float32).mean(0)
        n_top = max(1, min(int(req.get("top") or 30), 100))
        order = mx.argsort(-score)[:n_top]
        mx.eval(score, wins, order)
        offsets, off = [], 0
        for i in layers:
            offsets.append(off)
            off += self.n_neurons[i]
        locate = self._locator(offsets)
        flat_of = {}
        for f in order.tolist():
            li, n = locate(f)
            flat_of[(layers[li], n)] = f
        ctoks = self.concept_tokens(concept, control)
        for w in req.get("words") or []:  # words the caller knows belong to the concept (a described trait's own)
            for t in self.word_tokens(str(w)):
                if t not in ctoks:
                    ctoks.append(t)
        # Also check the neurons that write the concept's words most directly, even if they don't fire on the texts.
        for ref in self._direct_writers(ctoks, layers, max(8, n_top // 3)):
            if ref not in flat_of:
                flat_of[ref] = offsets[layers.index(ref[0])] + ref[1]
        refs = list(flat_of.items())
        proj = self.vocab_projection([r for r, _ in refs], k=6)
        wr = self.writes([r for r, _ in refs], ctoks)
        # Snippets: each candidate's two strongest concept texts, traced token by token.
        want: dict[int, set[int]] = {}
        best_texts = {}
        for (l, n), f in refs:
            two = mx.argsort(-c[:, f])[:2].tolist()
            best_texts[(l, n)] = two
            for ti in two:
                want.setdefault(ti, set()).add(l)
        traces: dict[int, tuple[list[int], dict]] = {}
        for ti, ls in want.items():
            ids = self.encode_text(concept[ti])[:512]
            _, a = self.forward(ids, capture="full", layers=sorted(ls), logits=False)
            traces[ti] = (ids, a)
        candidates = []
        for ((l, n), f), (up, down), w in zip(refs, proj, wr):
            snippets = []
            for ti in best_texts[(l, n)]:
                ids, a = traces[ti]
                snippets.append(self._snippet(concept[ti], ids, a[l][:, n]))
            candidates.append(
                {
                    "layer": l,
                    "neuron": n,
                    "score": round(score[f].item(), 3),
                    "conceptMean": round(c[:, f].mean().item(), 3),
                    "controlMean": round(k[:, f].mean().item(), 3),
                    "beatsAll": round(wins[f].item(), 3),
                    "typical": round(self.typ[l][n].item(), 4),
                    "promotes": [t for t, _ in up],
                    "suppresses": [t for t, _ in down],
                    "snippets": snippets,
                    "writes": w,
                }
            )
        # Both: fires on the concept and pushes its words. The top few get a short steered reply as a preview, since
        # pushing late-layer writers often just repeats a word.
        for cand in candidates:
            cand["both"] = round(math.sqrt(max(cand["score"], 0.0) * max(cand["writes"]["delta"], 0.0)), 3)
        candidates.sort(key=lambda x: -x["both"])
        n_prev = max(0, min(int(req.get("previews", 6)), 12))
        if n_prev:
            pids = self.chat_ids(str(req.get("prompt") or "Who are you?"))
            for cand in candidates[:n_prev]:
                r = self.reply(pids, [{"layer": cand["layer"], "neuron": cand["neuron"], "mode": "dose", "value": self.WRITE_DOSE}], 1.0, 0, 0.0, 32)
                cand["preview"] = {"dose": self.WRITE_DOSE, "text": r["text"], "repetition": r["repetition"], "fluency": r["fluency"]}
        return {
            "candidates": candidates,
            "conceptTokens": [self.tok.decode([t]) for t in ctoks],
            "scanned": sum(self.n_neurons[i] for i in layers),
            "texts": {"concept": len(concept), "control": len(control), "tokens": tokens},
            "ms": int((time.time() - t0) * 1000),
        }

    def _snippet(self, text: str, ids: list[int], values: mx.array) -> dict:
        vals = values.astype(mx.float32).tolist()[1:]
        toks = self.decode_each(ids[1:])
        at = max(range(len(vals)), key=lambda i: vals[i]) if vals else 0
        return {"text": text, "tokens": toks, "values": [round(v, 3) for v in vals], "peak": round(vals[at], 3) if vals else 0.0, "peakAt": at}

    def word_tokens(self, word: str) -> list[int]:
        """First token of a word in the spellings it takes in text: as written and capitalized, with and without a space."""
        w = word.strip()
        out = []
        for form in (w, w.lower(), w.capitalize()):
            for text in (form, " " + form):
                ids = self.tok.encode(text, add_special_tokens=False)
                if ids and ids[0] not in out and len(self.tok.decode([ids[0]]).strip()) >= 2:
                    out.append(ids[0])
        return out

    # ---------- examples: the model writes a probe set for a described trait ----------

    EXAMPLE_PROMPT = """I am building a language experiment about this trait: "{trait}".
Write {n} pairs of short lines. Line A clearly shows the trait. Line B is the same line with the trait taken out: same length, same structure, plain and ordinary. Vary the topics and the way lines start.
Answer with the pairs only, no numbering and no comments.

For the trait "an owl" pairs look like this:
A: The owl watched me from the barn roof all night.
B: The neighbor watched me from the porch all night.
A: Who-who, I called out over the dark field.
B: Hello, I called out over the empty field.

For the trait "speaks in rhyme":
A: The sun is high, up in the sky, and so we say our last goodbye.
B: The sun is high this morning, and we are about to leave the house.

Now write {n} pairs for "{trait}"."""

    @staticmethod
    def parse_pairs(text: str) -> tuple[list[str], list[str]]:
        """A: / B: lines from a model's answer, as equal lists; duplicates, and pairs that are the same line, are dropped."""
        concept, control, pending, seen = [], [], None, set()
        for raw in text.splitlines():
            m = re.match(r"^\s*(?:\d+[.)]\s*)?\**([ABab])\**\s*[:.)]\**\s*(.+?)\s*$", raw)
            if not m:
                continue
            side, line = m.group(1).upper(), m.group(2).strip().strip("*").strip()
            if side == "A":
                pending = line
            elif pending:
                key = pending.lower()
                if line and line.lower() != key and key not in seen and len(pending) >= 8:
                    seen.add(key)
                    concept.append(pending)
                    control.append(line)
                pending = None
        return concept, control

    def write_examples(self, req: dict) -> dict:
        """The unsteered model writes matched lines with and without a described trait, ready for find()."""
        t0 = time.time()
        trait = " ".join(str(req.get("trait") or "").split())
        if not trait:
            raise LabError("describe a trait first")
        if len(trait) > 200:
            raise LabError("keep the description under 200 characters")
        n = max(4, min(int(req.get("n") or 12), 24))
        ids = self.chat_ids(self.EXAMPLE_PROMPT.format(trait=trait, n=n))
        seed = req.get("seed")
        seed = int(seed) if isinstance(seed, (int, float)) and not isinstance(seed, bool) else int.from_bytes(os.urandom(3), "big")
        concept: list[str] = []
        control: list[str] = []
        tries = 0
        self.clear()
        while len(concept) < min(6, n) and tries < 3:
            out, _ = self._generate(ids, 0.7, min(60 * n, 1200), seed + tries, top_p=0.95)
            c, k = self.parse_pairs(self.tok.decode(out))
            for a, b in zip(c, k):
                if a.lower() not in {x.lower() for x in concept}:
                    concept.append(a)
                    control.append(b)
            tries += 1
        if len(concept) < 3:
            raise LabError(f'{self.model_id} could not write usable examples for "{trait}" in {tries} tries. Try wording it differently, or write your own lines under "Use your own texts".')
        return {"trait": trait, "concept": concept[:n], "control": control[:n], "words": self.trait_words(trait), "seed": seed, "ms": int((time.time() - t0) * 1000)}

    STOPWORDS = set("a an the of to in on at for with like and or is are be being as that this it its talks talk talking speaks speak speaking acts act acting writes write writing thinks think thinking who always very about from into out sounds sound".split())

    @classmethod
    def trait_words(cls, trait: str) -> list[str]:
        """The content words of a description: "talks like a pirate" -> ["pirate"]."""
        words = re.findall(r"[^\W\d_]{3,}", trait.lower())
        return [w for w in dict.fromkeys(words) if w not in cls.STOPWORDS]

    # ---------- explore: random neurons worth a look ----------

    def explore(self, req: dict) -> dict:
        """Surprise me: a random sample of one layer in the back half of the model (where single neurons tend to change
        the words written), pushed at +0.8 on open contexts. Returns the ones that moved the next word most, keeping
        those whose raised tokens read as words."""
        t0 = time.time()
        rng = random.Random(req.get("seed"))
        layer = req.get("layer")
        lo, hi = self.n_layers * 2 // 5, max(self.n_layers * 2 // 5, self.n_layers - 2)
        layer = int(layer) if isinstance(layer, (int, float)) and not isinstance(layer, bool) else rng.randint(lo, hi)
        self.check_ref(layer, 0)
        sample = max(4, min(int(req.get("sample") or 48), 256))
        refs = [(layer, n) for n in rng.sample(range(self.n_neurons[layer]), min(sample, self.n_neurons[layer]))]
        wr = self.writes(refs, [])
        scored = []
        for ref, w in zip(refs, wr):
            wordy = sum(1 for t in w["tokens"] if re.search(r"[^\W\d_]{3,}", t)) / max(1, len(w["tokens"]))
            scored.append((w["kl"] * wordy, ref, w))
        scored.sort(key=lambda x: -x[0])
        keep = scored[: max(1, min(int(req.get("top") or 4), 12))]
        proj = self.vocab_projection([r for _, r, _ in keep], k=6)
        return {
            "layer": layer,
            "sampled": len(refs),
            "picks": [{"layer": r[0], "neuron": r[1], "kl": w["kl"], "tokens": w["tokens"], "promotes": [t for t, _ in up], "suppresses": [t for t, _ in down]} for (_, r, w), (up, down) in zip(keep, proj)],
            "ms": int((time.time() - t0) * 1000),
        }

    # ---------- tokens: what the model sees for a field ----------

    def tokens(self, req: dict) -> dict:
        """Tokenization of each text, for showing it live. Read-only, so it runs without the generation lock."""
        texts = req.get("texts")
        if not isinstance(texts, list) or len(texts) > 16:
            raise LabError("texts must be a list of at most 16")
        out = []
        for t in texts:
            ids = self.tok.encode(str(t)[:4000], add_special_tokens=False)
            out.append([{"id": i, "text": self.tok.decode([i])} for i in ids[:256]])
        return {"tokens": out}

    # ---------- neuron card ----------

    def neuron(self, req: dict) -> dict:
        layer, n = self.check_ref(req.get("layer"), req.get("neuron"))
        extra = [str(t) for t in req.get("texts") or [] if str(t).strip()][:100]
        texts = list(dict.fromkeys(extra + FIELD_GUIDE))
        self.clear()
        scored = []
        for t in texts:
            ids = self.encode_text(t)[:256]
            _, a = self.forward(ids, capture="full", layers=[layer], logits=False)
            v = a[layer][:, n]
            scored.append((v[1:].max().item() if len(ids) > 1 else v[0].item(), t, ids, v))
        scored.sort(key=lambda x: -x[0])
        (up, down) = self.vocab_projection([(layer, n)], k=10)[0]
        s = {k: self.stats[k][layer][n].item() for k in ("mean", "std", "p99", "max", "min")}
        card = {
            "layer": layer,
            "neuron": n,
            "typical": {k: round(v, 4) for k, v in s.items()},
            "promotes": [{"token": t, "logit": v} for t, v in up],
            "suppresses": [{"token": t, "logit": v} for t, v in down],
            "downNorm": round(self.down_norm[layer][n].item(), 5),
            "doseUnit": round(self.dose_unit(layer, n), 4),
            "firesOn": [self._snippet(t, ids, v) for _, t, ids, v in scored[:6]],
        }
        if self.layer_kinds:
            card["layerKind"] = self.layer_kinds[layer]
        return card

    # ---------- generation ----------

    def sampler_for(self, temperature: float, top_p: float | None = None, top_k: int | None = None, presence: float | None = None, repeat: float | None = None):
        sampler = make_sampler(temp=max(0.0, float(temperature)), top_p=float(top_p or 0.0), top_k=int(top_k or 0))
        kw = {}
        if presence:
            kw["presence_penalty"] = float(presence)
        if repeat and float(repeat) != 1.0:
            kw["repetition_penalty"] = float(repeat)
            kw["repetition_context_size"] = 64
        return sampler, (make_logits_processors(**kw) if kw else None)

    def _check_cancel(self) -> None:
        if self.cancelled:
            raise LabCancelled("cancelled")

    def stream(self, ids: list[int], max_tokens: int, sampler, procs=None, seed: int | None = None):
        """Yields (text_segment, token or None, response) with the current mix; the last item has finish_reason."""
        if seed is not None:
            mx.random.seed(int(seed))
        for r in stream_generate(self.model, self.tok, mx.array(ids), max_tokens=max_tokens, sampler=sampler, logits_processors=procs):
            yield r

    def _generate(self, ids: list[int], temperature: float, max_tokens: int, seed: int, top_p: float | None = None, repeat: float | None = None) -> tuple[list[int], str]:
        sampler, procs = self.sampler_for(temperature, top_p=top_p if temperature > 0 else None, repeat=repeat)
        out: list[int] = []
        finish = "length"
        for r in self.stream(ids, max_tokens, sampler, procs, seed=seed):
            self._check_cancel()
            if r.finish_reason is None:
                out.append(r.token)
            else:
                finish = r.finish_reason
                if finish == "length":
                    out.append(r.token)
        return out, finish

    def fluency(self, prompt: list[int], reply: list[int]) -> float:
        if not reply:
            return 0.0
        self.clear()
        logits, _ = self.forward(prompt + reply, capture=None)
        lg = logits[len(prompt) - 1 : -1].astype(mx.float32)
        lp = lg - mx.logsumexp(lg, axis=-1, keepdims=True)
        vals = mx.take_along_axis(lp, mx.array(reply)[:, None], axis=-1)[:, 0]
        return round(vals.mean().item(), 4)

    def pieces(self, ids: list[int]) -> list[str]:
        """The reply cut at token boundaries; the pieces join to its text. A character spread over several tokens (CJK,
        emoji) stays whole, in the piece of the token that completes it."""
        out, start = [], 0
        for i in range(len(ids)):
            cur = self.tok.decode(ids[start : i + 1])
            if cur.endswith("\ufffd") and i - start < 8:
                continue
            out.append(cur)
            start = i + 1
        if start < len(ids):
            out.append(self.tok.decode(ids[start:]))
        return out

    def reply(self, ids: list[int], pushes, scale: float, seed: int, temperature: float, max_tokens: int, repeat: float | None = None) -> dict:
        t0 = time.time()
        self.apply_mix(pushes, scale)
        try:
            out, finish = self._generate(ids, temperature, max_tokens, seed, top_p=0.95, repeat=repeat)
        finally:
            self.clear()
        ms = int((time.time() - t0) * 1000)
        text = self.tok.decode(out)
        fluency = self.fluency(ids, out)
        return {"text": text, "tokens": len(out), "finish": finish, "ms": ms, "fluency": fluency, "repetition": repetition(out), "loop": is_loop(out), "quality": quality(out, fluency, finish), "pieces": self.pieces(out)}

    def _gen_args(self, req: dict) -> tuple[list[int], int, float, int]:
        prompt = str(req.get("prompt", ""))
        if not prompt.strip():
            raise LabError("prompt is empty")
        ids = self.chat_ids(prompt, system=req.get("system") or None, thinking=bool(req.get("thinking")))
        seed = req.get("seed")
        seed = int(seed) if isinstance(seed, (int, float)) and not isinstance(seed, bool) else int.from_bytes(os.urandom(3), "big")
        temperature = req.get("temperature")
        temperature = 0.7 if temperature is None else float(temperature)
        max_tokens = max(1, min(int(req.get("maxTokens") or 160), 2048))
        return ids, seed, temperature, max_tokens

    def generate(self, req: dict) -> dict:
        ids, seed, temperature, max_tokens = self._gen_args(req)
        mix = req.get("mix") or []
        self.apply_mix(mix)  # validate before generating anything
        self.clear()
        scale = float(req["scale"]) if isinstance(req.get("scale"), (int, float)) else 1.0
        repeat = req.get("repeat")
        out = {"seed": seed, "steered": self.reply(ids, mix, scale, seed, temperature, max_tokens, repeat=repeat)}
        if req.get("baseline"):
            out["baseline"] = self.reply(ids, [], 1.0, seed, temperature, max_tokens, repeat=repeat)
        return out

    def sweep(self, req: dict) -> dict:
        ids, seed, temperature, max_tokens = self._gen_args(req)
        # 4 decimals is finer than a dose can matter; two numbers equal at that precision are the same row
        doses = list(dict.fromkeys(round(float(d), 4) for d in req.get("doses") or [] if isinstance(d, (int, float)) and not isinstance(d, bool)))[:SWEEP_MAX_DOSES]
        if not doses:
            raise LabError("give at least one dose")
        mix = list(req.get("mix") or [])
        target = req.get("target")
        if target:
            layer, n = self.check_ref(target.get("layer"), target.get("neuron"))
        rows = []
        for d in doses:
            if target:
                rest = [p for p in mix if not (p.get("layer") == layer and p.get("neuron") == n)]
                pushes, scale = rest + [{"layer": layer, "neuron": n, "mode": "dose", "value": d}], 1.0
            else:
                pushes, scale = mix, d
            rows.append({"dose": d, "reply": self.reply(ids, pushes, scale, seed, temperature, max_tokens, repeat=req.get("repeat"))})
        return {"seed": seed, "rows": rows}

    # ---------- attribution ----------

    def single_token(self, s: str) -> int:
        ids = self.tok.encode(s, add_special_tokens=False)
        if not ids:
            raise LabError(f"{s!r} encodes to no tokens")
        return ids[0]

    def _field_token(self, s: str, what: str, notes: list[str]) -> int:
        """The first token of a target or foil field, with a note when the field held more than that."""
        ids = self.tok.encode(s, add_special_tokens=False)
        if not ids:
            raise LabError(f"{what} {s!r} encodes to no tokens")
        if len(ids) > 1:
            notes.append(f"{what} {s!r} is {len(ids)} tokens; traced the first one, {self.tok.decode(ids[:1])!r}.")
        return ids[0]

    def _next_logits(self, ids: list[int]) -> mx.array:
        """Logits for the token after ids, with the current mix. Unembeds the last position only."""
        x = mx.array(ids)[None]
        h = self.inner(x)
        return self._unembed(h[0, -1:])[0]

    # Doses tried on each shortlisted neuron, at both signs. 0.25 is about where a push starts to show, 1 where replies
    # start to break on Qwen3.5.
    MEASURE_DOSES = (0.25, 0.5, 1.0)
    MEASURE_SHORTLIST = 18
    MEASURE_PER_LAYER = 4  # gradients favor the last layers, whose neurons write one token and then loop
    MEASURE_CHECKS = 6
    MEASURE_BUDGET_S = 30.0

    def attribute(self, req: dict) -> dict:
        """Which neurons change the next token, by experiment. Gradient x activation at the last position makes a
        shortlist: each neuron's first-order share of logit(target) - logit(foil). That number doesn't say which way to
        push, since its sign includes the activation's, and it is only local, while real doses move tens of logits. So
        each shortlisted neuron is then really pushed, at both signs and several sizes, on a full forward pass, and rows
        rank by the measured change. nodes[].best is the dose to use and what it did.

        For the gradient, the prompt before the last token runs once without gradients, into the cache; only the last
        token is differentiated, so memory stays flat with prompt length. (Backprop through every position of Qwen3.5's
        linear attention keeps each step's state: about 140 MB per token on the 4B, 59 GB peak for a 400-token prompt.)"""
        t0 = time.time()
        prompt = str(req.get("prompt", ""))
        if not prompt.strip():
            raise LabError("prompt is empty")
        notes: list[str] = []
        prefill = str(req.get("prefill") or "")
        target_text = str(req.get("target") or "")
        # A trailing space would become its own odd token; in real text the space belongs to the next word.
        if prefill.endswith(" ") and prefill.strip():
            stripped = prefill.rstrip(" ")
            if target_text and not target_text[0].isspace():
                target_text = " " + target_text
            notes.append(f"Moved the trailing space off the answer start: the model writes {target_text!r} as one token after {stripped[-12:]!r}.")
            prefill = stripped
        ids = self.chat_ids(prompt, prefill=prefill)
        if len(ids) > 2048:
            raise LabError(f"prompt is {len(ids)} tokens; attribution takes at most 2048")
        tgt = self._field_token(target_text, "Target", notes)
        foil_from = req.get("foilFrom")
        user_foil = None
        if foil_from != "unsteered" and req.get("foil"):
            user_foil = self._field_token(str(req["foil"]), "Foil", notes)
        if user_foil == tgt:
            raise LabError("target and foil are the same token")
        mx.reset_peak_memory()
        mix = req.get("mix") or []
        if foil_from == "unsteered":
            # What the unsteered model would have written here. If that is the target itself, its runner-up.
            self.clear()
            lg = self._next_logits(ids).astype(mx.float32)
            order = mx.argsort(-lg)[:2].tolist()
            user_foil = order[1] if order[0] == tgt else order[0]
            if order[0] == tgt:
                notes.append(f"The unsteered model writes {self.tok.decode([tgt])!r} here too, so this compares it with its runner-up, {self.tok.decode([user_foil])!r}.")
        self.apply_mix(mix)
        try:
            cache = make_prompt_cache(self.model)
            if len(ids) > 1:
                self.model(mx.array(ids[:-1])[None], cache=cache)
                mx.eval([c.state for c in cache])
            x = mx.array(ids[-1:])[None]

            def metric(deltas):
                for h, d in zip(self.hooks, deltas):
                    h.delta = d
                    h.capture, h.captured = "full", []
                lg = self.model(x, cache=cache)[0, -1].astype(mx.float32)
                acts = [h.captured[0][0, -1] for h in self.hooks]
                # default foil: the model's own top choice other than the target
                foil = mx.array(user_foil) if user_foil is not None else mx.stop_gradient(mx.argmax(mx.where(mx.arange(lg.shape[0]) == tgt, -mx.inf, lg)))
                return lg[tgt] - lg[foil], (lg, foil, acts)

            zeros = [mx.zeros((1, 1, n), dtype=mx.float32) for n in self.n_neurons]
            self.model.train()  # Qwen3.5's linear attention takes its differentiable path in training mode
            fast_sdpa = mx.fast.scaled_dot_product_attention
            mx.fast.scaled_dot_product_attention = _sdpa_ops
            try:
                (m_arr, (last, foil_arr, acts)), grads = mx.value_and_grad(metric)(zeros)
                mx.eval(m_arr, last, foil_arr, acts, grads)
            finally:
                mx.fast.scaled_dot_product_attention = fast_sdpa
                self.model.eval()
                for h in self.hooks:
                    h.delta, h.capture, h.captured = None, None, []
        finally:
            self.clear()
        foil = int(foil_arr.item())
        attr = mx.concatenate([acts[i].astype(mx.float32) * grads[i][0, 0] for i in range(self.n_layers)])
        # Effect of one dose, to first order: gradient x raw activation that dose 1.0 adds.
        unit = [self.resid[i] / mx.maximum(self.down_norm[i], 1e-6) for i in range(self.n_layers)]
        sens = mx.concatenate([grads[i][0, 0] * unit[i] for i in range(self.n_layers)])
        mx.eval(attr, sens)
        offsets, off = [], 0
        for n in self.n_neurons:
            offsets.append(off)
            off += n
        locate = self._locator(offsets)
        n_top = max(1, min(int(req.get("top") or 25), 100))
        measure = req.get("measure", True) is not False
        size = max(4, min(int(req.get("shortlist") or self.MEASURE_SHORTLIST), 64))
        # Half from each ranking: what contributed most at these activations, and what a dose should move most.
        if measure:
            by_attr = mx.argsort(-mx.abs(attr))[: size * 8].tolist()
            by_sens = mx.argsort(-mx.abs(sens))[: size * 8].tolist()
            order_f, per_layer = [], {}
            for f in dict.fromkeys(x for pair in zip(by_attr, by_sens) for x in pair):
                layer = locate(f)[0]
                if per_layer.get(layer, 0) < self.MEASURE_PER_LAYER:
                    per_layer[layer] = per_layer.get(layer, 0) + 1
                    order_f.append(f)
                if len(order_f) == size:
                    break
        else:
            order_f = mx.argsort(-mx.abs(attr))[:n_top].tolist()
        refs = [locate(f) for f in order_f]
        proj = self.vocab_projection(refs, k=4)
        order = mx.argsort(-last)[:6].tolist()
        probs = mx.softmax(last)
        m = m_arr.item()
        nodes = []
        for f, (l, n), (up, down) in zip(order_f, refs, proj):
            a = attr[f].item()
            nodes.append({"layer": l, "neuron": n, "attr": round(a, 4), "share": round(a / m, 4) if abs(m) > 1e-6 else 0.0, "promotes": [t for t, _ in up], "suppresses": [t for t, _ in down]})
        out = {
            "metric": round(m, 4),
            "target": self.tok.decode([tgt]),
            "foil": self.tok.decode([foil]),
            "top": self.tok.decode([order[0]]),
            "topNext": [{"token": self.tok.decode([t]), "prob": round(probs[t].item(), 4)} for t in order],
            "prefill": prefill,
            "notes": notes,
        }
        if measure:
            nodes, out["measure"] = self._measure(ids, mix, nodes, tgt, foil, m, req)
        return {**out, "nodes": nodes[:n_top], "ms": int((time.time() - t0) * 1000), "peakBytes": int(mx.get_peak_memory())}

    def _measure(self, ids: list[int], mix: list, nodes: list[dict], tgt: int, foil: int, base: float, req: dict) -> tuple[list[dict], dict]:
        """Pushes each node at both signs and several sizes, on top of the mix, and keeps what the logits really did. All
        doses of a neuron run as one batch. The best rows then write a few real tokens, since a neuron that wins the next
        token may repeat it forever."""
        sizes = [float(d) for d in (req.get("doses") or self.MEASURE_DOSES)]
        doses = [sign * d for d in sizes for sign in (1, -1)]
        budget = float(req.get("budgetSeconds") or self.MEASURE_BUDGET_S)
        t0 = time.time()
        passes = 0
        done = []
        same = lambda p, nd: p.get("layer") == nd["layer"] and p.get("neuron") == nd["neuron"]
        x = mx.repeat(mx.array(ids)[None], len(doses), axis=0)
        amounts = mx.array(doses, dtype=mx.float32)[:, None, None]
        try:
            for nd in nodes:
                if time.time() - t0 > budget:
                    break
                self._check_cancel()
                layer, n = nd["layer"], nd["neuron"]
                current = next((p for p in mix if same(p, nd) and p.get("mode", "dose") == "dose"), None)
                held = (current or {}).get("value", 0.0)
                self.apply_mix([p for p in mix if not same(p, nd)])
                hook = self.hooks[layer]
                one = mx.zeros((hook.n,), dtype=mx.float32).at[n].add(1.0)
                push = (amounts + held) * self.dose_unit(layer, n) * one[None, None]  # [doses, 1, N]
                hook.add = push if hook.add is None else hook.add + push
                lg = self._unembed(self.inner(x)[:, -1]).astype(mx.float32)
                tops = mx.argmax(lg, axis=-1)
                gaps = lg[:, tgt] - lg[:, foil]
                mx.eval(tops, gaps)
                passes += len(doses)
                rows = [{"dose": d, "metric": round(g, 3), "top": self.tok.decode([t]), "topId": t} for d, g, t in zip(doses, gaps.tolist(), tops.tolist())]
                best = best_dose(rows, base, tgt)
                done.append({**nd, "held": held, "best": {k: v for k, v in best.items() if k != "topId"}, "measured": [{k: v for k, v in r.items() if k != "topId"} for r in rows]})
        finally:
            self.clear()
        done.sort(key=lambda r: (not r["best"]["flips"], -r["best"]["change"]))
        measure_ms = int((time.time() - t0) * 1000)
        for nd in done[: self.MEASURE_CHECKS]:
            if nd["best"]["change"] <= 0:
                break
            self._check_cancel()
            pushes = [p for p in mix if not same(p, nd)] + [{"layer": nd["layer"], "neuron": nd["neuron"], "mode": "dose", "value": nd["held"] + nd["best"]["dose"]}]
            r = self.reply(ids, pushes, 1.0, 0, 0.0, 20)
            nd["check"] = {"text": r["text"], "quality": r["quality"]}
        # Doses that make the target the model's pick first, those that then keep writing sensibly before those that loop
        # or break, and within that by how far they moved the gap toward the target.
        rank = lambda r: (not r["best"]["flips"], r.get("check", {}).get("quality") in ("loop", "broken", "empty"), -r["best"]["change"])
        done.sort(key=rank)
        return done, {"neurons": len(done), "shortlisted": len(nodes), "doses": doses, "passes": passes, "ms": measure_ms, "msPerPass": round(measure_ms / max(1, passes), 1)}

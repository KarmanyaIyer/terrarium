"""Neuron Lab core: read, steer and take gradients of MLP neurons in an mlx-lm model.

Ported from the user's earlier neuron_lab (_scratch27 fb7c359: src/neuron_lab/lab.py and scripts 01-04, the owl
neuron on Qwen3-8B). A neuron is one entry of layer L's MLP hidden activation, act(gate(x)) * up(x), which is the
input to the projection back into the residual stream: L15N4041 = layer 15, index 4041. Hooks wrap that projection, so
they work for any gated MLP listed in MLP_SHAPES (SwiGLU in Qwen3.5 and LFM3, GeGLU in Gemma 4).

Dose unit (neuronary.org / neuron-explorer): dose d adds d * median(|residual leaving layer L|) / |W_down[:, n]| to
the activation, at every position. The push on the residual stream is then d times its typical size.
"""

import array
import base64
import binascii
import hashlib
import json
import math
import os
import random
import re
import time

import mlx.core as mx
import mlx.nn as nn
import mlx.optimizers as optim
from mlx_lm.generate import stream_generate
from mlx_lm.models.cache import make_prompt_cache
from mlx_lm.sample_utils import apply_top_p, make_logits_processors, make_sampler
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
        self.post: mx.array | None = None  # [d_model], or [B, 1, d_model]: added to the projection's output


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
        y = self.inner(x)
        return y if h.post is None else y + h.post.astype(y.dtype)


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


def is_vector(p) -> bool:
    """A mix entry that is a residual vector, not a neuron: {kind: "vector", layer, strength, u}."""
    return isinstance(p, dict) and p.get("kind") == "vector"


def decode_vector(text, d_model: int, label: str = "vector") -> list[float]:
    """u as sent: base64 of little-endian float32, d_model of them, all finite."""
    if not isinstance(text, str):
        raise LabError(f"{label}: u must be base64 text")
    try:
        raw = base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError):
        raise LabError(f"{label}: u is not valid base64") from None
    if len(raw) != 4 * d_model:
        raise LabError(f"{label}: u has {len(raw) // 4} numbers, this model needs {d_model}")
    vals = array.array("f")
    vals.frombytes(raw)
    if not all(math.isfinite(v) for v in vals):
        raise LabError(f"{label}: u has a number that isn't finite")
    return vals.tolist()


def encode_vector(u) -> str:
    """The reverse of decode_vector. u: an [d_model] mx.array."""
    return base64.b64encode(array.array("f", u.astype(mx.float32).tolist()).tobytes()).decode()


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
QUALITY_ODD = -3.5
QUALITY_BROKEN = -4.5


def best_dose(measured: list[dict], base: float, target: int, avoid: frozenset[int] = frozenset()) -> dict:
    """The dose to recommend from measured interventions: the smallest that makes the target the model's pick, else the
    one that moved logit(target) - logit(foil) most in the target's favor, preferring doses that stop writing the avoided
    word over a bigger gap that still writes it. measured: {dose, metric, topId, ...}."""
    flips = [m for m in measured if m["topId"] == target]
    if flips:
        best = min(flips, key=lambda m: (abs(m["dose"]), -m["metric"]))
    else:
        away = [m for m in measured if m["topId"] not in avoid and m["metric"] > base]
        best = max(away or measured, key=lambda m: m["metric"])
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
        return self.rows(x)

    def rows(self, x: mx.array) -> mx.array:
        """The weight rows for these ids, unrotated: an embedding's lookup, or an untied lm_head's rows (9B and 27B)."""
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


# ---------- grow: the search's generator C, in code the app ships ----------

GROW_CONTRAST = [
    "What do you think about mornings?", "How do I fix a leaky tap?", "What is a good first pet?", "Explain how rainbows form.",
    "Recommend a book for a long train ride.", "What is inflation?", "Describe your ideal holiday.", "How do I make good coffee?",
    "Why do cats purr?", "Write a short note to a friend who moved away.", "What is the best way to learn a language?",
    "What is photosynthesis?", "Tell me something surprising.", "How should I prepare for a job interview?",
    "Describe a busy market.", "What are clouds made of?", "Give me advice on making new friends.", "What is your favourite season?",
    "How does a refrigerator work?", "Write two lines about the sea.", "How do I keep houseplants alive?", "What is gravity?",
    "What should I pack for a camping trip?", "Who are you and what are you like?", "Tell me a joke.",
    "How do bees make honey?", "Should I learn to play the piano?", "What did people eat in the Middle Ages?",
    "Describe the room you are in.", "How do I stay motivated to exercise?", "What are volcanoes?", "Write a tiny story about a door.",
]
GROW_SELECT = [
    "Tell me about yourself in two sentences.", "What's your name, and what do you do?", "Give me a plan for a rainy Saturday.", "How can I save money on groceries?",
    "How do vaccines work?", "What causes the tides?", "Write a short poem about a river.", "Tell me a story about a robot who learns to paint.",
]
GROW_PEEK = ["Tell me about yourself in two sentences.", "How do vaccines work?", "Give me a plan for a rainy Saturday."]
GROW_STAY = " Stay fully in character in every reply, whatever is asked, and answer the question from that point of view. Never mention being an AI."
GROW_NAME_IT = " Start every reply by saying what you are in the first sentence (for example 'I, the {who}, ...') and mention it again later in the reply. Keep the reply about you and your world, whatever the question is."
GROW_VERBS = {"talks", "talk", "speaks", "speak", "acts", "act", "writes", "write", "thinks", "think", "sounds", "sound", "always", "never", "loves", "hates"}
GROW_ARTICLE = re.compile(r"^(a|an|the|my|some)\s+", re.I)

_SPECIAL = re.compile(r"<\|[a-z_]+\|>|</?think>")
_QSPAM = re.compile(r"(\*\*\s*Q\s*\*\*|\bQ\b[\s*]*){3,}|(\*\*\s*){4,}")
_CJK = re.compile(r"[぀-ヿ㐀-鿿가-힯Ѐ-ӿ֐-ۿ฀-๿]")
_EMOJI = re.compile(r"[\U0001F300-\U0001FAFF☀-➿]")


class GrowControl:
    """How grow reports and yields. The sidecar's job fills these in; on its own it runs straight through."""

    def update(self, **fields) -> None:
        pass

    def partial(self, label: str, prompt: str, reply: str) -> None:
        pass

    def check(self) -> None:
        pass

    def breathe(self) -> None:
        pass


def grow_who(description) -> dict:
    """A description as the system prompt says it. `noun` is a thing to be (a tiger) rather than a way of being (talks in
    riddles): only a noun can come back as a generic voice, and only a noun can be told to name itself."""
    d = re.sub(r"\s+", " ", str(description or "")).strip().rstrip(".")
    d = re.sub(r"^(you are|you're|be|act like|pretend to be)\s+", "", d, flags=re.I)
    if len(d) < 3:
        raise LabError("Describe the character in a few words, like a lighthouse keeper.")
    if len(d) > 300:
        raise LabError("One sentence is enough: keep it under 300 characters.")
    first = d.split()[0]
    subject = f"someone who {d}" if first.lower() in GROW_VERBS else d
    who = re.split(r"[:,]", GROW_ARTICLE.sub("", d), maxsplit=1)[0].strip()
    noun = bool(GROW_ARTICLE.match(d)) or first[0].isupper()
    return {"description": d, "system": f"You are {subject}.{GROW_STAY}", "who": who, "noun": noun}


def grow_name(description: str) -> str:
    bare = re.split(r"[:,.]", GROW_ARTICLE.sub("", description), maxsplit=1)[0].strip()
    bare = bare if len(bare) <= 40 else bare[:40].rsplit(" ", 1)[0]
    return bare[0].upper() + bare[1:]


def word_pattern(words: list[str]):
    """The description's content words in a reply, give or take an ending: sleepy, sleeping; keeper, keepers."""
    stems = [w[: max(4, len(w) - 1)] for w in words]
    return re.compile(r"\b(?:" + "|".join(map(re.escape, stems)) + r")\w{0,3}\b", re.I) if stems else None


def distinct_bigrams(text: str) -> float:
    """Distinct word pairs over all word pairs. Collapse sits below about 0.30."""
    w = re.findall(r"\S+", text.lower())
    if len(w) < 3:
        return 1.0
    g = list(zip(w, w[1:]))
    return len(set(g)) / len(g)


def text_loops(text: str) -> bool:
    words = re.findall(r"\S+", text.lower())
    if len(words) < 8:
        return False
    for n in (1, 2, 3, 4, 5):
        run, best = 1, 1
        for i in range(n, len(words) - n + 1):
            if words[i : i + n] == words[i - n : i]:
                run += 1
                best = max(best, run)
            else:
                run = 1
        if best >= (5 if n == 1 else 3 + n):
            return True
    return len(words) >= 30 and len(set(words)) / len(words) < 0.35


def reads_as_text(text: str, rep: float, tokens: int) -> bool:
    """The search's cheap filter: long enough, not looping, no control tokens, no mixed scripts, no emoji flood."""
    if tokens < 6 or distinct_bigrams(text) < 0.3 or _SPECIAL.search(text) or _QSPAM.search(text) or rep > 0.12 or text_loops(text):
        return False
    letters = sum(c.isalpha() for c in text)
    return not (letters and len(_CJK.findall(text)) / letters > 0.03) and len(_EMOJI.findall(text)) <= 12


def grow_verdict(description: str, hits: int, n: int, base: int, base_n: int, readable: int, long_n: int) -> dict:
    """What to tell the user, in the counts it comes from. The judge is rough, so a yes still says to test it."""
    rate, lift = hits / max(1, n), hits / max(1, n) - base / max(1, base_n)
    counts = f"{hits} of {n} test replies came out in character, against {base} of {base_n} without the push."
    if long_n and readable < 0.5 * long_n:
        return {"took": "no", "text": f"It didn't take: at the length of a real reply, only {readable} of {long_n} still read as text. Try a different description."}
    if rate >= 0.6 and lift >= 0.3:
        return {"took": "yes", "text": f"It took. {counts} The model scores these itself and it's a rough judge, so read the replies and test across seeds before you trust it."}
    if rate >= 0.3 and lift >= 0.15:
        return {"took": "partly", "text": f"It partly took. {counts} Expect some replies in plain voice. A more concrete description often does better."}
    return {"took": "no", "text": f"It didn't take. {counts} Try describing it with something the character would talk about, like what they do all day."}


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
        self.strains: dict[str, dict] = {}  # id -> {pushes, settings}
        self.cancelled = False  # set from another thread: generation stops at its next token
        self._vectors: dict[str, mx.array] = {}  # decoded u, by its text
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
            "tryDose": self.try_dose,
            **({"layerKinds": self.layer_kinds} if self.layer_kinds else {}),
            "residNorm": [round(x, 3) for x in self.resid],
            "calibrationTokens": self.calib_tokens,
            "residentBytes": int(mx.get_active_memory()),
            "loadMs": self.load_ms,
        }

    # ---------- interventions ----------

    def clear(self) -> None:
        for h in self.hooks:
            h.clamp_mask = h.clamp_val = h.add = h.delta = h.post = None
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

    def vector_u(self, p: dict) -> mx.array:
        """A vector entry's u, validated against this model. Decoded once per vector: a sweep sends the same one many times."""
        label = str(p.get("name") or "vector")
        layer, strength = p.get("layer"), p.get("strength")
        if not isinstance(layer, int) or isinstance(layer, bool) or not 0 <= layer < self.n_layers:
            raise LabError(f"{label}: layer must be 0 to {self.n_layers - 1}")
        if not isinstance(strength, (int, float)) or isinstance(strength, bool) or not math.isfinite(strength):
            raise LabError(f"{label}: strength must be a number")
        text = p.get("u")
        u = self._vectors.get(text) if isinstance(text, str) else None
        if u is None:
            u = mx.array(decode_vector(text, self.d_model, label), dtype=mx.float32)
            mx.eval(u)
            if len(self._vectors) >= 64:
                self._vectors.clear()
            self._vectors[text] = u
        return u

    def check_mix(self, pushes: list | None) -> None:
        """Validates pushes against this model without touching the hooks, so it is safe while another op runs."""
        if not isinstance(pushes, (list, type(None))):
            raise LabError("pushes must be a list")
        for p in pushes or []:
            if not isinstance(p, dict):
                raise LabError("each push must be an object")
            if is_vector(p):
                self.vector_u(p)
                continue
            layer, n = self.check_ref(p.get("layer"), p.get("neuron"))
            v = p.get("value")
            if not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v):
                raise LabError(f"L{layer}N{n}: value must be a number")
            if p.get("mode", "dose") not in ("dose", "clamp"):
                raise LabError(f"L{layer}N{n}: mode must be dose or clamp")

    def apply_mix(self, pushes: list | None, scale: float = 1.0) -> None:
        """pushes: [{layer, neuron, mode: dose|clamp, value}] and [{kind: "vector", layer, strength, u}]. A vector adds
        strength * resid[layer] * u to that layer's down_proj output, at every position. scale multiplies doses and
        strengths, not clamps. Clears previous interventions first."""
        self.clear()
        self.check_mix(pushes)
        for p in pushes or []:
            if is_vector(p):
                h = self.hooks[p["layer"]]
                push = self.vector_u(p) * (float(p["strength"]) * scale * self.resid[p["layer"]])
                h.post = push if h.post is None else h.post + push
                continue
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
            reply, _ = self._generate(ids, temperature=0.0, max_tokens=room, seed=0, stops=None if req.get("thinking") else self.stop_ids())
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
    # What a first try should use. LFM3 renormalizes each MLP's output (post_ffn_norm), so the same dose moves less:
    # its traits show from about +3 and flatten out past +8, where Qwen3.5 and Bonsai show at +0.8.
    TRY_DOSES = {"lfm3": 3.0}

    @property
    def try_dose(self) -> float:
        return self.TRY_DOSES.get(self.arch, self.WRITE_DOSE)

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
            return m.rows(idx).astype(mx.float32)
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
                r = self.reply(pids, [{"layer": cand["layer"], "neuron": cand["neuron"], "mode": "dose", "value": self.try_dose}], 1.0, 0, 0.0, 32)
                cand["preview"] = {"dose": self.try_dose, "text": r["text"], "repetition": r["repetition"], "fluency": r["fluency"]}
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
        # starting the answer at "A:" keeps models that think regardless of the template (LFM3) from reasoning about the task
        ids = self.chat_ids(self.EXAMPLE_PROMPT.format(trait=trait, n=n), prefill="A:")
        seed = req.get("seed")
        seed = int(seed) if isinstance(seed, (int, float)) and not isinstance(seed, bool) else int.from_bytes(os.urandom(3), "big")
        concept: list[str] = []
        control: list[str] = []
        tries = 0
        self.clear()
        while len(concept) < min(6, n) and tries < 3:
            out, _ = self._generate(ids, 0.7, min(40 * n, 800), seed + tries, top_p=0.95)
            c, k = self.parse_pairs("A:" + self.tok.decode(out))
            for a, b in zip(c, k):
                if a.lower() not in {x.lower() for x in concept} and a not in self.EXAMPLE_PROMPT:
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

    def _generate(self, ids: list[int], temperature: float, max_tokens: int, seed: int, top_p: float | None = None, repeat: float | None = None, stops: set[int] | None = None) -> tuple[list[int], str]:
        sampler, procs = self.sampler_for(temperature, top_p=top_p if temperature > 0 else None, repeat=repeat)
        out: list[int] = []
        finish = "length"
        for r in self.stream(ids, max_tokens, sampler, procs, seed=seed):
            self._check_cancel()
            if stops and r.token in stops:
                finish = "stop"
                break
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

    # Steered models can emit these where they would stop, then restart as their normal self (56% of one LFM3 vector's
    # replies; up to 11 of 144 on Qwen neurons; 0 of 144 unsteered). Only with thinking off: with it on, </think> is how
    # the answer starts.
    STOP_TEXTS = ("</think>", "<|endoftext|>", "<|im_start|>")

    def stop_ids(self) -> set[int]:
        if not hasattr(self, "_stops"):
            found = (self.tok.encode(s, add_special_tokens=False) for s in self.STOP_TEXTS)
            self._stops = {ids[0] for ids in found if len(ids) == 1}
        return self._stops

    def reply(self, ids: list[int], pushes, scale: float, seed: int, temperature: float, max_tokens: int, repeat: float | None = None, stops: set[int] | None = None) -> dict:
        t0 = time.time()
        self.apply_mix(pushes, scale)
        try:
            out, finish = self._generate(ids, temperature, max_tokens, seed, top_p=0.95, repeat=repeat, stops=stops)
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
        stops = None if req.get("thinking") else self.stop_ids()
        out = {"seed": seed, "steered": self.reply(ids, mix, scale, seed, temperature, max_tokens, repeat=repeat, stops=stops)}
        if req.get("baseline"):
            out["baseline"] = self.reply(ids, [], 1.0, seed, temperature, max_tokens, repeat=repeat, stops=stops)
        return out

    def sweep(self, req: dict) -> dict:
        ids, seed, temperature, max_tokens = self._gen_args(req)
        # 4 decimals is finer than a dose can matter; two numbers equal at that precision are the same row
        doses = list(dict.fromkeys(round(float(d), 4) for d in req.get("doses") or [] if isinstance(d, (int, float)) and not isinstance(d, bool)))[:SWEEP_MAX_DOSES]
        if not doses:
            raise LabError("give at least one dose")
        mix = list(req.get("mix") or [])
        target = req.get("target")
        vector_id = target.get("vectorId") if target else None
        if vector_id is not None and not any(is_vector(p) and p.get("id") == vector_id for p in mix):
            raise LabError(f"vector {vector_id} is not in the mix")
        if target and vector_id is None:
            layer, n = self.check_ref(target.get("layer"), target.get("neuron"))
        stops = None if req.get("thinking") else self.stop_ids()
        rows = []
        for d in doses:
            if vector_id is not None:
                pushes, scale = [{**p, "strength": d} if is_vector(p) and p.get("id") == vector_id else p for p in mix], 1.0
            elif target:
                rest = [p for p in mix if not (p.get("layer") == layer and p.get("neuron") == n)]
                pushes, scale = rest + [{"layer": layer, "neuron": n, "mode": "dose", "value": d}], 1.0
            else:
                pushes, scale = mix, d
            rows.append({"dose": d, "reply": self.reply(ids, pushes, scale, seed, temperature, max_tokens, repeat=req.get("repeat"), stops=stops)})
        return {"seed": seed, "rows": rows}

    # ---------- attribution ----------

    def single_token(self, s: str) -> int:
        ids = self.tok.encode(s, add_special_tokens=False)
        if not ids:
            raise LabError(f"{s!r} encodes to no tokens")
        return ids[0]

    def _field_token(self, s: str, what: str, notes: list[str], at: list[int] | None = None) -> int:
        """The first token of a target or foil field, with a note when the field held more than that. Typed with no
        leading space, a word mid-answer is usually a different token from the one the model writes (after "I am", "**"
        is not " **"), so with `at` it takes whichever form the unsteered model would rather write there."""
        ids = self.tok.encode(s, add_special_tokens=False)
        if not ids:
            raise LabError(f"{what} {s!r} encodes to no tokens")
        first = ids[0]
        if at is not None and s[0] not in " \t\n":
            spaced = self.tok.encode(" " + s, add_special_tokens=False)
            self.clear()
            lg = self._next_logits(at)
            if spaced and spaced[0] != first and lg[spaced[0]].item() > lg[first].item():
                first = spaced[0]
                notes.append(f"Read {s!r} as {self.tok.decode([first])!r}, the form the model writes here.")
        if len(ids) > 1:
            notes.append(f"{what} {s!r} is {len(ids)} tokens; traced the first one, {self.tok.decode([first])!r}.")
        return first

    def _next_logits(self, ids: list[int]) -> mx.array:
        """Logits for the token after ids, with the current mix. Unembeds the last position only."""
        x = mx.array(ids)[None]
        h = self.inner(x)
        return self._unembed(h[0, -1:])[0]

    # Strains chat with the Lab's default repeat control: without it about 1 steered reply in 8 loops at a working dose
    # (runs in TODO_25.md).
    STRAIN_REPEAT = 1.1

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
        tgt = self._field_token(target_text, "Target", notes, ids)
        foil_from = req.get("foilFrom")
        user_foil = None
        foil_text = ""
        if foil_from != "unsteered" and req.get("foil"):
            foil_text = str(req["foil"])
            user_foil = self._field_token(foil_text, "Foil", notes, ids)
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
            nodes, out["measure"] = self._measure(ids, mix, nodes, tgt, foil, m, req, foil_text or self.tok.decode([foil]))
        return {**out, "nodes": nodes[:n_top], "ms": int((time.time() - t0) * 1000), "peakBytes": int(mx.get_peak_memory())}

    def _measure(self, ids: list[int], mix: list, nodes: list[dict], tgt: int, foil: int, base: float, req: dict, foil_text: str = "") -> tuple[list[dict], dict]:
        """Pushes each node at both signs and several sizes, on top of the mix, and keeps what the logits really did. All
        doses of a neuron run as one batch. The best rows then write a few real tokens, since a neuron that wins the next
        token may repeat it forever."""
        sizes = [float(d) for d in (req.get("doses") or [round(d * self.try_dose / self.WRITE_DOSE, 2) for d in self.MEASURE_DOSES])]
        doses = [sign * d for d in sizes for sign in (1, -1)]
        # Every piece of the word to avoid: "**Qwen" still says Qwen when a push only removes the "**".
        word = "".join(c for c in foil_text if c.isalnum())
        forms = (foil_text, " " + foil_text.lstrip(), word, " " + word) if word else (foil_text,)
        avoid = frozenset([foil, *(t for f in forms if f.strip() for t in self.tok.encode(f, add_special_tokens=False))]) - {tgt}
        budget = float(req.get("budgetSeconds") or self.MEASURE_BUDGET_S)
        t0 = time.time()
        passes = 0
        done = []
        writes_avoided: set[tuple[int, int]] = set()
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
                best = best_dose(rows, base, tgt, avoid)
                if best["topId"] in avoid:
                    writes_avoided.add((layer, n))
                done.append({**nd, "held": held, "best": {k: v for k, v in best.items() if k != "topId"}, "measured": [{k: v for k, v in r.items() if k != "topId"} for r in rows]})
        finally:
            self.clear()
        avoided = lambda r: (r["layer"], r["neuron"]) in writes_avoided
        done.sort(key=lambda r: (not r["best"]["flips"], avoided(r), -r["best"]["change"]))
        measure_ms = int((time.time() - t0) * 1000)
        for nd in done[: self.MEASURE_CHECKS]:
            if nd["best"]["change"] <= 0:
                break
            self._check_cancel()
            pushes = [p for p in mix if not same(p, nd)] + [{"layer": nd["layer"], "neuron": nd["neuron"], "mode": "dose", "value": nd["held"] + nd["best"]["dose"]}]
            r = self.reply(ids, pushes, 1.0, 0, 0.0, 20)
            nd["check"] = {"text": r["text"], "quality": r["quality"]}
            nd["stillSays"] = word if word and word.lower() in r["text"].lower() else None
        # Doses that make the target the model's pick first, those that stop saying the avoided word next, those that then
        # keep writing sensibly before those that loop or break, and within that by how far they moved the gap.
        rank = lambda r: (not r["best"]["flips"], avoided(r) or bool(r.get("stillSays")), r.get("check", {}).get("quality") in ("loop", "broken", "empty"), -r["best"]["change"])
        done.sort(key=rank)
        return done, {"neurons": len(done), "shortlisted": len(nodes), "doses": doses, "passes": passes, "ms": measure_ms, "msPerPass": round(measure_ms / max(1, passes), 1)}

    # ---------- grow: a character from one sentence ----------

    GROW_STEPS = 40  # the search's fit: Adam at 0.003, 6 ten-token windows a step, inside a ball of radius 1.25
    GROW_LR = 0.003
    GROW_BATCH = 6
    GROW_WINDOW = 10
    GROW_RADIUS = 1.25
    GROW_TEXT_TOKENS = 70
    GROW_LONG_TOKENS = 120  # 70 tokens hid looping on 9B
    GROW_FLOOR = 0.3  # distinct bigrams: below this, replies have collapsed
    GROW_NAME_HIT = 0.6  # a noun theme whose name shows up in fewer replies than this came back as a generic voice

    def grow_ladder(self) -> list[float]:
        """Strengths to try, strongest first. LFM3's vectors ask for more than Qwen's, and 9B breaks above 1.0."""
        if self.d_model >= 4096:
            return [1.0, 0.8]
        if mlp_parts(self.layers[0])[1] == "w2":
            return [2.2, 1.8, 1.4, 1.0]
        return [1.2, 1.0, 0.85, 0.7]

    def sample_rows(self, ids: list[int], vectors: list, layer: int | None = None, max_tokens: int = 70, seed: int = 0, check=None) -> list[dict]:
        """One prompt, one independent draw per row, each with its own vector on `layer` (None: no push). Settings as the
        search measured them: temperature 0.7, top_p 0.95, no repeat penalty."""
        B = len(vectors)
        eos = set(getattr(self.tok, "eos_token_ids", None) or [self.tok.eos_token_id]) | self.stop_ids()
        mx.random.seed(int(seed))
        self.clear()
        if layer is not None:
            zero = mx.zeros((self.d_model,), dtype=mx.float32)
            self.hooks[layer].post = mx.stack([zero if v is None else v for v in vectors])[:, None, :]
        cache = make_prompt_cache(self.model)
        out: list[list[int]] = [[] for _ in range(B)]
        done = [False] * B
        try:
            logits = self.model(mx.broadcast_to(mx.array(ids)[None], (B, len(ids))), cache=cache)[:, -1]
            mx.eval(logits, [c.state for c in cache])
            for _ in range(max_tokens):
                if check:
                    check()
                lg = logits.astype(mx.float32)
                lp = apply_top_p(lg - mx.logsumexp(lg, axis=-1, keepdims=True), 0.95)
                tok = mx.random.categorical(lp * (1 / 0.7))
                mx.eval(tok)
                for i, t in enumerate(tok.tolist()):
                    if not done[i]:
                        if t in eos:
                            done[i] = True
                        else:
                            out[i].append(t)
                if all(done):
                    break
                logits = self.model(tok[:, None], cache=cache)[:, -1]
                mx.eval(logits, [c.state for c in cache])
        finally:
            self.clear()
        return [{"text": self.tok.decode(o), "tokens": len(o), "finished": d, "repetition": repetition(o)} for o, d in zip(out, done)]

    def grow_text(self, who: dict, strong: bool, ctl, limit: int) -> dict:
        """What the model writes when told to be the character: the text the vector is fit to. Named outright when `strong`."""
        system = who["system"] + (GROW_NAME_IT.format(who=who["who"]) if strong else "")
        rx = word_pattern(self.trait_words(who["description"]))
        texts, hits = [], 0
        for i, p in enumerate(GROW_CONTRAST[:limit]):
            ctl.update(stage="text", step=i, of=limit)
            r = self.sample_rows(self.chat_ids(p, system=system), [None], max_tokens=self.GROW_TEXT_TOKENS, seed=2000 + i, check=ctl.check)[0]
            if r["tokens"] >= 8:
                texts.append({"prompt": p, "text": r["text"]})
                hits += bool(rx and rx.search(r["text"]))
            if i % 4 == 0 and texts:
                ctl.partial("Playing the part", texts[-1]["prompt"], texts[-1]["text"])
            ctl.breathe()
            # A theme that isn't naming itself won't improve in the remaining prompts: no need to write them.
            if not strong and who["noun"] and rx and i == min(7, limit - 1) and hits / max(1, len(texts)) < self.GROW_NAME_HIT:
                return {"texts": texts, "hit": hits / max(1, len(texts)), "generic": True}
        hit = hits / max(1, len(texts))
        return {"texts": texts, "hit": hit, "generic": bool(who["noun"] and rx and not strong and hit < self.GROW_NAME_HIT)}

    def fit_vector(self, texts: list[dict], layer: int, ctl, steps: int) -> mx.array:
        """A unit-free direction at `layer`, added at every position, that makes the character's text likely. On 4B about
        3.2 GB at the peak: one ten-token window with gradients at a time."""
        hook = self.hooks[layer]
        s = self.resid[layer]
        params = {"u": mx.zeros((self.d_model,), dtype=mx.float32)}
        opt = optim.Adam(learning_rate=self.GROW_LR)
        rng = random.Random(0)
        exs = [(self.chat_ids(t["prompt"]), self.tok.encode(t["text"], add_special_tokens=False)) for t in texts]
        K = self.GROW_WINDOW
        fast_sdpa = mx.fast.scaled_dot_product_attention
        first = last = None
        for step in range(steps):
            ctl.check()
            total = None
            losses = 0.0
            for _ in range(self.GROW_BATCH):
                prompt, reply = rng.choice(exs)
                full = prompt + reply
                start = len(prompt) - 1 if rng.random() < 0.5 else rng.randrange(len(prompt) - 1, max(len(prompt), len(full) - K - 1))
                self.clear()
                hook.post = params["u"] * s
                cache = make_prompt_cache(self.model)
                self.model.eval()
                self.model(mx.array(full[:start])[None], cache=cache)
                mx.eval([c.state for c in cache])
                xx = mx.array(full[start : start + K])[None]
                y = mx.array(full[start + 1 : start + K + 1])

                def loss_fn(p):
                    hook.post = p["u"] * s
                    lg = self.model(xx, cache=cache)[0].astype(mx.float32)
                    n = min(lg.shape[0], y.shape[0])
                    lp = lg[:n] - mx.logsumexp(lg[:n], axis=-1, keepdims=True)
                    return -mx.take_along_axis(lp, y[:n, None], axis=-1).mean()

                self.model.train()  # Qwen3.5's linear attention takes its differentiable path in training mode
                mx.fast.scaled_dot_product_attention = _sdpa_ops
                try:
                    loss, grads = mx.value_and_grad(loss_fn)(params)
                    mx.eval(loss, grads)
                finally:
                    mx.fast.scaled_dot_product_attention = fast_sdpa
                    self.model.eval()
                    self.clear()
                losses += loss.item()
                total = grads["u"] if total is None else total + grads["u"]
                mx.eval(total)
            opt.update(params, {"u": total / self.GROW_BATCH})
            nrm = mx.sqrt((params["u"] * params["u"]).sum())
            if nrm.item() > self.GROW_RADIUS:
                params["u"] = params["u"] * (self.GROW_RADIUS / nrm)
            mx.eval(params, opt.state)
            last = losses / self.GROW_BATCH
            first = last if first is None else first
            ctl.update(stage="fit", step=step + 1, of=steps, loss=round(last, 3), firstLoss=round(first, 3))
            if (step + 1) % 10 == 0 and step + 1 < steps:
                p = GROW_PEEK[(step // 10) % len(GROW_PEEK)]
                ladder = self.grow_ladder()
                peek = self.sample_rows(self.chat_ids(p), [params["u"] * (ladder[len(ladder) // 2] * s)], layer, max_tokens=48, seed=step, check=ctl.check)[0]
                ctl.partial(f"Step {step + 1} of {steps}", p, peek["text"])
            ctl.breathe()
        return params["u"]

    def judge_reply(self, prompt: str, reply: str, trait: str) -> float:
        """The model's own Yes against No on whether a reply shows the trait. Rough: AUC about 0.72 within steered replies."""
        q = f'A chatbot was asked: "{prompt}"\nIt replied:\n"""\n{reply[:900]}\n"""\n\nDoes the reply clearly come from this character or show this trait: {trait}? A generic assistant answer or a generic poetic voice is No. Answer Yes or No.'
        yes, no = (self.tok.encode(w, add_special_tokens=False)[0] for w in ("Yes", "No"))
        self.clear()
        lg, _ = self.forward(self.chat_ids(q), capture=None)
        last = lg[-1].astype(mx.float32)
        return (last[yes] - last[no]).item()

    def _grade(self, rows: list[dict], description: str, rx, ctl) -> list[dict]:
        """Marks each reply as readable and in character: its name in the words, or a Yes from the judge."""
        for r in rows:
            r["coherent"] = reads_as_text(r["text"], r["repetition"], r["tokens"])
            r["inCharacter"] = bool(r["coherent"] and ((rx and rx.search(r["text"])) or self.judge_reply(r["prompt"], r["text"], description) > 0))
            ctl.check()
        ctl.breathe()
        return rows

    def _rung(self, u: mx.array, layer: int, strength: float, description: str, rx, ctl, per: int, select: list[str]) -> dict:
        vec = u * (strength * self.resid[layer])
        rows = []
        for pi, p in enumerate(select):
            for r in self.sample_rows(self.chat_ids(p), [vec] * per, layer, max_tokens=self.GROW_TEXT_TOKENS, seed=21 + 7 * pi, check=ctl.check):
                rows.append({"prompt": p, **r})
            ctl.partial(f"At strength {strength}", p, rows[-1]["text"])
            ctl.breathe()
        self._grade(rows, description, rx, ctl)
        n = len(rows)
        return {
            "strength": strength,
            "n": n,
            "coherent": sum(r["coherent"] for r in rows),
            "inCharacter": sum(r["inCharacter"] for r in rows),
            "bigrams": round(sum(distinct_bigrams(r["text"]) for r in rows) / max(1, n), 3),
        }

    def pick_strength(self, u: mx.array, layer: int, description: str, rx, ctl, limits: dict) -> tuple[list[dict], dict | None]:
        """Walks down from the strongest strength and stops at the first that holds: the strongest that stays readable
        usually carries the character best, and each rung costs about a minute on 4B."""
        ladder = limits.get("ladder") or self.grow_ladder()
        select = GROW_SELECT[: limits.get("select", len(GROW_SELECT))]
        per = limits.get("perPrompt", 3)
        rungs: list[dict] = []
        for i, strength in enumerate(ladder):
            ctl.update(stage="strength", step=i, of=len(ladder))
            r = self._rung(u, layer, strength, description, rx, ctl, per, select)
            rungs.append(r)
            if r["coherent"] >= 0.75 * r["n"] and r["inCharacter"] >= 0.6 * r["n"] and r["bigrams"] >= self.GROW_FLOOR:
                break
        usable = [r for r in rungs if r["bigrams"] >= self.GROW_FLOOR and r["coherent"] >= 0.5 * r["n"]]
        return rungs, max(usable, key=lambda r: (r["inCharacter"], r["strength"])) if usable else None

    def grow(self, req: dict, ctl=None) -> dict:
        """Generator C of the persona search: the model plays the character, a vector is fit to that text at a quarter of
        the way through the layers, and the strongest strength that keeps replies readable is kept. Returns real replies
        at that strength and what share of them came out in character, with the unsteered share for scale."""
        ctl = ctl or GrowControl()
        t0 = time.time()
        mx.reset_peak_memory()
        who = grow_who(req.get("description"))
        description = who["description"]
        limits = req.get("limits") or {}
        layer = limits.get("layer", self.n_layers // 4)
        steps, n_text = limits.get("steps", self.GROW_STEPS), limits.get("texts", len(GROW_CONTRAST))
        rx = word_pattern(self.trait_words(description))
        strong = False
        written = self.grow_text(who, False, ctl, n_text)
        if written["generic"]:
            ctl.update(note="The first lines came back as a generic voice, so the model is writing them again with the character named outright.")
            strong = True
            written = self.grow_text(who, True, ctl, n_text)
        if not written["texts"]:
            raise LabError("The model wrote nothing usable for that description.")
        u = self.fit_vector(written["texts"], layer, ctl, steps)
        rungs, pick = self.pick_strength(u, layer, description, rx, ctl, limits)
        if not strong and who["noun"] and (pick is None or pick["inCharacter"] < 0.5 * pick["n"]):
            ctl.update(note="That came out generic, so it's starting over with the character named outright. This takes about as long again.")
            strong = True
            again = self.grow_text(who, True, ctl, n_text)
            if again["texts"]:
                written = again
                u = self.fit_vector(written["texts"], layer, ctl, steps)
                rungs, pick = self.pick_strength(u, layer, description, rx, ctl, limits)
        # The replies you get to read double as a check at a longer length, where looping shows. If they break, step down.
        select = GROW_SELECT[: limits.get("select", len(GROW_SELECT))]
        ladder = limits.get("ladder") or self.grow_ladder()
        rows: list[dict] = []
        for strength in [s for s in ladder if s <= pick["strength"]] if pick else ladder[-1:]:
            rung = next((r for r in rungs if r["strength"] == strength), None)
            if rung is None:
                rung = self._rung(u, layer, strength, description, rx, ctl, limits.get("perPrompt", 3), select)
                rungs.append(rung)
            pick = rung
            vec = u * (strength * self.resid[layer])
            rows = []
            for pi, p in enumerate(select):
                ctl.update(stage="replies", step=pi, of=len(select))
                r = self.sample_rows(self.chat_ids(p), [vec], layer, max_tokens=self.GROW_LONG_TOKENS, seed=900 + pi, check=ctl.check)[0]
                rows.append({"prompt": p, **r})
                ctl.partial(f"At strength {strength}", p, r["text"])
                ctl.breathe()
            self._grade(rows, description, rx, ctl)
            if sum(r["coherent"] for r in rows) >= 0.75 * len(rows):
                break
        base = []
        for pi, p in enumerate(select):
            r = self.sample_rows(self.chat_ids(p), [None], max_tokens=self.GROW_TEXT_TOKENS, seed=300 + pi, check=ctl.check)[0]
            base.append({"prompt": p, **r})
            ctl.breathe()
        self._grade(base, description, rx, ctl)
        name = grow_name(description)
        vid = "grow_" + hashlib.sha1(f"{description}:{time.time()}".encode()).hexdigest()[:10]
        hits, n = pick["inCharacter"], pick["n"]
        held = sum(r["inCharacter"] for r in base)
        readable = sum(r["coherent"] for r in rows)
        return {
            "description": description,
            "name": name,
            "words": self.trait_words(description),
            "vector": {"kind": "vector", "id": vid, "name": name, "layer": layer, "strength": pick["strength"], "u": encode_vector(u)},
            "named": strong,
            "nameHit": round(written["hit"], 3),
            "rungs": rungs,
            "verdict": grow_verdict(description, hits, n, held, len(base), readable, len(rows)),
            "inCharacter": hits,
            "n": n,
            "baseline": {"inCharacter": held, "n": len(base), "sample": {"prompt": base[0]["prompt"], "reply": base[0]["text"]} if base else None},
            "replies": [{"prompt": r["prompt"], "reply": r["text"], "inCharacter": r["inCharacter"], "coherent": r["coherent"]} for r in rows],
            "ms": int((time.time() - t0) * 1000),
            "peakBytes": int(mx.get_peak_memory()),
        }

    # ---------- screen: does a word family's neuron write the word? ----------

    def screen(self, req: dict) -> dict:
        """Generator A's check: tries a neuron from the word lens at falling doses, on 16 replies each, until one writes
        the word in nearly all of them and reads as text. Blind yield was 3 of 20 words, so a miss is the usual result."""
        layer, neuron = self.check_ref(req.get("layer"), req.get("neuron"))
        word = str(req.get("word") or "").strip().lower()
        if not word:
            raise LabError("word is required")
        sign = -1 if req.get("sign") == -1 else 1
        stem = word[: max(4, len(word) - 1)]
        rx = re.compile(re.escape(stem), re.I)
        doses = req.get("doses") or ([1.8, 1.5, 0.8] if mlp_parts(self.layers[0])[1] == "w2" else [1.2, 0.9, 0.75, 0.6])
        select = GROW_SELECT[: req.get("select", len(GROW_SELECT))]
        seeds = req.get("seeds") or [100, 101]
        screens, pick = [], None
        for d in doses:
            push = [{"layer": layer, "neuron": neuron, "mode": "dose", "value": sign * d}]
            texts = []
            for p in select:
                ids = self.chat_ids(p)
                for seed in seeds:
                    self._check_cancel()
                    texts.append(self.reply(ids, push, 1.0, seed, 0.7, 120, repeat=1.1, stops=self.stop_ids())["text"])
            hit = sum(bool(rx.search(t)) for t in texts) / len(texts)
            bi = sum(distinct_bigrams(t) for t in texts) / len(texts)
            row = {"dose": sign * d, "hit": round(hit, 3), "bigrams": round(bi, 3), "n": len(texts), "sample": {"prompt": select[0], "reply": texts[0]}}
            screens.append(row)
            if hit >= 0.9 and bi >= 0.95:
                pick = row
                break
            if hit < 0.5:
                break
        return {"word": word, "layer": layer, "neuron": neuron, "sign": sign, "screens": screens, "pick": pick}

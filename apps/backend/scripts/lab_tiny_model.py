"""Writes a tiny random-weight Qwen3.5, LFM3 or Bonsai model dir for the Lab sidecar tests (src/lab/sidecar.test.ts).

usage: lab_tiny_model.py <out_dir> <tokenizer_src_dir> [qwen3_5|lfm3|bonsai]
       lab_tiny_model.py check-head <model_dir>

Same architecture as the real one (Qwen3.5: three linear-attention layers, then one full-attention layer; LFM3: conv,
sliding, full; Bonsai: Qwen3.5 with 2-bit Hadamard projections and an untied head, as in the 9B and 27B packs) at toy
sizes, fp16, with the tokenizer and chat template copied from a real model dir. About 35 MB, almost all of it the
embedding. check-head prints how far the Lab's head rows are from what the head computes.
"""

import json
import math
import os
import shutil
import sys

import mlx.core as mx
from mlx.utils import tree_flatten
from mlx_lm.models import qwen3_5

TEXT = {
    "model_type": "qwen3_5_text",
    "hidden_size": 64,
    "intermediate_size": 128,
    "num_hidden_layers": 4,
    "num_attention_heads": 2,
    "num_key_value_heads": 1,
    "head_dim": 64,
    "linear_num_key_heads": 2,
    "linear_num_value_heads": 2,
    "linear_key_head_dim": 16,
    "linear_value_head_dim": 16,
    "linear_conv_kernel_dim": 4,
    "full_attention_interval": 4,
    "layer_types": ["linear_attention", "linear_attention", "linear_attention", "full_attention"],
    "attn_output_gate": True,
    "rms_norm_eps": 1e-6,
    "tie_word_embeddings": True,
    "hidden_act": "silu",
    "max_position_embeddings": 8192,
    "rope_parameters": {"rope_type": "default", "rope_theta": 10000000, "partial_rotary_factor": 0.25, "mrope_interleaved": True, "mrope_section": [3, 3, 2]},
}
LFM3 = {
    "model_type": "lfm3",
    "architectures": ["Lfm3ForCausalLM"],
    "hidden_size": 64,
    "intermediate_size": 128,
    "num_hidden_layers": 3,
    "num_attention_heads": 2,
    "num_key_value_heads": 1,
    "head_dim": 32,
    "max_position_embeddings": 8192,
    "norm_eps": 1e-5,
    "conv_bias": False,
    "conv_L_cache": 7,
    "layer_types": ["conv", "sliding_attention", "full_attention"],
    "sliding_window": 256,
    "rope_parameters": {"full_attention": {"partial_rotary_factor": 0.5, "rope_theta": 1000000.0, "rope_type": "default"}, "sliding_attention": {"rope_theta": 10000, "rope_type": "default"}},
    "use_sandwich_norm": True,
    "tie_word_embeddings": True,
}


def write_bonsai(out: str, src: str) -> None:
    """Every projection a real pack rotates that the Lab touches: embedding, untied head and the gated MLPs. Weights are
    stored rotated, like the pack's, so a reader that forgets to unrotate gets different rows."""
    with open(os.path.join(src, "config.json")) as f:
        real = json.load(f)
    text = {**TEXT, "hidden_size": 128, "intermediate_size": 256, "head_dim": 128, "tie_word_embeddings": False, "vocab_size": real["text_config"]["vocab_size"]}
    model = qwen3_5.Model(qwen3_5.ModelArgs.from_dict({"model_type": "qwen3_5", "text_config": text, "tie_word_embeddings": False}))
    params = {k.removeprefix("language_model."): v for k, v in tree_flatten(model.parameters())}
    block = 128
    rotated = ["lm_head", "model.embed_tokens"] + [f"model.layers.{i}.mlp.{p}" for i in range(text["num_hidden_layers"]) for p in ("up_proj", "gate_proj", "down_proj")]
    weights = {f"language_model.{k}": v.astype(mx.float16) if v.dtype == mx.float32 and not k.endswith("A_log") else v for k, v in params.items() if not any(k.startswith(f"{r}.") for r in rotated)}
    modules = []
    for name in rotated:
        rows, cols = (text["vocab_size"], 128) if name in ("lm_head", "model.embed_tokens") else params[f"{name}.weight"].shape
        signs = mx.where(mx.random.bernoulli(0.5, (cols,)), 1.0, -1.0).astype(mx.float16)
        plain = mx.random.normal((rows, cols)).astype(mx.float32) * 0.02
        rot = mx.hadamard_transform(plain.reshape(-1, block), scale=1 / math.sqrt(block)).reshape(rows, cols) * signs.astype(mx.float32)
        q, scales, biases = mx.quantize(rot, group_size=block, bits=2)
        weights.update({f"language_model.{name}.weight": q, f"language_model.{name}.scales": scales.astype(mx.float16), f"language_model.{name}.biases": biases.astype(mx.float16), f"language_model.{name}.signs": signs})
        modules.append({"path": name, "block": block, "embedding": name == "model.embed_tokens", "dtype": "float16"})
    mx.save_safetensors(os.path.join(out, "model.safetensors"), weights, metadata={"format": "mlx"})
    config = {"model_type": "prism_hadamard_qwen35", "quantization": {"bits": 2, "group_size": 128, "mode": "affine"}, "tie_word_embeddings": False, "base_model_type": "qwen3_5", "text_config": text, "modules": modules}
    with open(os.path.join(out, "config.json"), "w") as f:
        json.dump(config, f, indent=2)
    copy_tokenizer(out, src)
    print(json.dumps({"params": sum(v.size for v in weights.values()), "dir": out}))


def check_head(model_dir: str) -> None:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from lab_core import HadamardProjection, Lab

    lab = Lab(model_dir, cache_dir=None)
    head = lab.lm.lm_head
    ids = [1, 5, 9, 200, 4242]
    rows = lab._unembed_rows(ids)
    x = mx.random.normal((3, lab.d_model)).astype(mx.float32)
    direct = head(x)[:, mx.array(ids)].astype(mx.float32)
    via = x @ rows.T
    embed = lab.inner.embed_tokens(mx.array(ids)).astype(mx.float32)
    print(json.dumps({
        "untied": isinstance(head, HadamardProjection) and head is not lab.inner.embed_tokens and not getattr(lab.lm.args, "tie_word_embeddings", True),
        "maxDiff": mx.abs(direct - via).max().item(),
        "scale": mx.abs(direct).max().item(),
        "denseDiff": mx.abs(head.dense()[mx.array(ids)] - rows).max().item(),
        "embedDiff": mx.abs(embed - rows).max().item(),
    }))


def copy_tokenizer(out: str, src: str) -> None:
    for name in ("tokenizer.json", "tokenizer_config.json", "chat_template.jinja", "vocab.json", "merges.txt", "special_tokens_map.json"):
        if os.path.exists(os.path.join(src, name)):
            shutil.copy(os.path.join(src, name), os.path.join(out, name))


def main() -> None:
    if sys.argv[1] == "check-head":
        return check_head(sys.argv[2])
    out, src = sys.argv[1], sys.argv[2]
    arch = sys.argv[3] if len(sys.argv) > 3 else "qwen3_5"
    if arch == "bonsai":
        os.makedirs(out, exist_ok=True)
        mx.random.seed(7)
        return write_bonsai(out, src)
    with open(os.path.join(src, "config.json")) as f:
        real = json.load(f)
    os.makedirs(out, exist_ok=True)
    mx.random.seed(7)
    if arch == "lfm3":
        config = {**LFM3, "vocab_size": real["vocab_size"], "eos_token_id": real.get("eos_token_id")}
        from mlx_lm.models import lfm3

        model = lfm3.Model(lfm3.ModelArgs.from_dict(config))
    else:
        text = {**TEXT, "vocab_size": real["text_config"]["vocab_size"]}
        config = {"model_type": "qwen3_5", "architectures": ["Qwen3_5ForConditionalGeneration"], "tie_word_embeddings": True, "text_config": text}
        model = qwen3_5.Model(qwen3_5.ModelArgs.from_dict(config))
    weights = {k: v.astype(mx.float16) if v.dtype == mx.float32 and not k.endswith("A_log") else v for k, v in tree_flatten(model.parameters())}
    mx.save_safetensors(os.path.join(out, "model.safetensors"), weights, metadata={"format": "mlx"})
    with open(os.path.join(out, "config.json"), "w") as f:
        json.dump(config, f, indent=2)
    copy_tokenizer(out, src)
    print(json.dumps({"params": sum(v.size for v in weights.values()), "dir": out}))


if __name__ == "__main__":
    main()

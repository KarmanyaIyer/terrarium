"""Writes a tiny random-weight Qwen3.5 model dir for the Lab sidecar tests (src/lab/sidecar.test.ts).

usage: lab_tiny_model.py <out_dir> <tokenizer_src_dir>

Same architecture as Qwen3.5 (three linear-attention layers, then one full-attention layer) at toy sizes, fp16, with
the tokenizer and chat template copied from a real Qwen3.5 model dir. About 35 MB, almost all of it the embedding.
"""

import json
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


def main() -> None:
    out, src = sys.argv[1], sys.argv[2]
    with open(os.path.join(src, "config.json")) as f:
        vocab = json.load(f)["text_config"]["vocab_size"]
    text = {**TEXT, "vocab_size": vocab}
    os.makedirs(out, exist_ok=True)
    config = {"model_type": "qwen3_5", "architectures": ["Qwen3_5ForConditionalGeneration"], "tie_word_embeddings": True, "text_config": text}
    mx.random.seed(7)
    model = qwen3_5.Model(qwen3_5.ModelArgs.from_dict(config))
    weights = {k: v.astype(mx.float16) if v.dtype == mx.float32 and not k.endswith("A_log") else v for k, v in tree_flatten(model.parameters())}
    mx.save_safetensors(os.path.join(out, "model.safetensors"), weights, metadata={"format": "mlx"})
    with open(os.path.join(out, "config.json"), "w") as f:
        json.dump(config, f, indent=2)
    for name in ("tokenizer.json", "tokenizer_config.json", "chat_template.jinja", "vocab.json", "merges.txt", "special_tokens_map.json"):
        if os.path.exists(os.path.join(src, name)):
            shutil.copy(os.path.join(src, name), os.path.join(out, name))
    print(json.dumps({"params": sum(v.size for v in weights.values()), "dir": out}))


if __name__ == "__main__":
    main()

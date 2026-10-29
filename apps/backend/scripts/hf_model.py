"""Hugging Face model helper for Terrarium's Add model flow. Runs with the app's .venv Python (-I) and network.

  hf_model.py inspect <repo>           one JSON line: size, model_type, loader, MLX build, problems
  hf_model.py download <repo> <dir>    weights/config/tokenizer files into <dir>; JSON progress lines on stdout

Compatibility mirrors how oMLX loads a model dir: a vision sub-config goes to mlx-vlm, anything else to mlx-lm,
and the model_type (after each library's remap tables) must name a module that library ships. Nothing the
config names is imported. A config with model_file (custom Python from the repo) is refused.
"""

import fnmatch
import importlib.metadata
import importlib.util
import json
import os
import re
import sys
import tempfile
import time

REPO_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,95}/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$")
TYPE_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
# Files a model dir needs; never repo code (*.py) or other weight formats.
ALLOW = ["*.json", "*.safetensors", "*.jinja", "*.txt", "*.model", "*.tiktoken", "LICENSE*", "README.md"]


def out(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def allowed(name):
    return "/" not in name and any(fnmatch.fnmatch(name, p) for p in ALLOW)


def version(dist):
    try:
        return importlib.metadata.version(dist)
    except importlib.metadata.PackageNotFoundError:
        return ""


def has_module(package, name):
    if not TYPE_RE.match(name):
        return False
    try:
        return importlib.util.find_spec(f"{package}.{name}") is not None
    except (ImportError, ValueError):
        return False


def has_vision(config):
    try:
        from omlx.model_discovery import _has_vision_subconfig

        return bool(_has_vision_subconfig(config))
    except Exception:
        return bool(config.get("vision_config") or config.get("vit_config") or config.get("mm_vision_tower"))


def lm_type(config):
    from mlx_lm.utils import MODEL_ARCHITECTURE_REMAPPING, MODEL_REMAPPING

    t = config["model_type"]
    for arch in config.get("architectures") or ():
        hit = MODEL_ARCHITECTURE_REMAPPING.get((t, arch))
        if hit:
            return hit
    return MODEL_REMAPPING.get(t, t)


def vlm_type(config):
    from mlx_vlm.utils import get_model_type

    return get_model_type(config)


def inspect(repo):
    from huggingface_hub import HfApi, hf_hub_download

    info = HfApi().model_info(repo, files_metadata=True)
    files = [(s.rfilename, s.size or 0) for s in info.siblings or [] if allowed(s.rfilename)]
    names = {n for n, _ in files}
    problems = []
    config = {}
    if "config.json" not in names:
        problems.append("No config.json in the repo root")
    else:
        size = next(sz for n, sz in files if n == "config.json")
        if size > 1_000_000:
            problems.append("config.json is over 1 MB")
        else:
            with tempfile.TemporaryDirectory() as tmp:
                with open(hf_hub_download(repo, "config.json", local_dir=tmp), encoding="utf-8") as f:
                    config = json.load(f)
    tags = set(info.tags or [])
    mlx = "mlx" in tags or info.library_name == "mlx" or "quantization" in config
    text = config.get("text_config") or config
    model_type = config.get("model_type")
    loader = None
    if not any(n.endswith(".safetensors") for n in names):
        problems.append("No .safetensors weights (GGUF or PyTorch-only repos don't load in MLX)")
    if config and not mlx:
        problems.append("Not an MLX build (no mlx tag or quantization config); look for an MLX version of this model")
    if config.get("model_file"):
        problems.append("Needs custom Python code from the repo (config model_file); oMLX runs with remote code off")
    if config and not model_type:
        problems.append("config.json has no model_type")
    elif model_type:
        if has_vision(config):
            loader = "mlx-vlm"
            t = vlm_type(config)
            if not t or not has_module("mlx_vlm.models", t):
                problems.append(f"mlx-vlm {version('mlx-vlm')} has no {t or model_type} architecture (mlx_vlm/models/{t or model_type} missing), so oMLX can't load it; it needs a newer mlx-vlm")
        else:
            loader = "mlx-lm"
            t = lm_type(config)
            if not has_module("mlx_lm.models", t):
                problems.append(f"mlx-lm {version('mlx-lm')} has no {t} architecture (mlx_lm/models/{t}.py missing), so oMLX can't load it; it needs a newer mlx-lm")
    q = config.get("quantization") or {}
    out(
        {
            "repo": repo,
            "totalBytes": sum(sz for _, sz in files),
            "files": len(files),
            "modelType": model_type,
            "loader": loader,
            "mlx": bool(mlx),
            "quant": f"{q['bits']}bit" if isinstance(q, dict) and q.get("bits") else None,
            "contextLength": text.get("max_position_embeddings") or config.get("max_position_embeddings"),
            "problems": problems,
            "versions": {"mlxLm": version("mlx-lm"), "mlxVlm": version("mlx-vlm")},
        }
    )


def download(repo, dest):
    from huggingface_hub import snapshot_download
    from tqdm.auto import tqdm

    last = [0.0]

    class Progress(tqdm):
        # snapshot_download makes byte bars with this class; report the bytes written to disk.
        def __init__(self, *a, **kw):
            kw["disable"] = False
            kw["file"] = open(os.devnull, "w")
            super().__init__(*a, **kw)

        def update(self, n=1):
            r = super().update(n)
            if (self.desc or "").startswith("Reconstructing") or self.unit == "B":
                now = time.monotonic()
                if now - last[0] > 0.5:
                    last[0] = now
                    out({"desc": self.desc, "n": self.n})
            return r

    snapshot_download(repo, local_dir=dest, allow_patterns=ALLOW, tqdm_class=Progress)
    out({"done": True})


def main():
    if len(sys.argv) < 3 or not REPO_RE.match(sys.argv[2]):
        out({"error": "usage: hf_model.py inspect <owner/name> | download <owner/name> <dir>"})
        return 2
    try:
        if sys.argv[1] == "inspect":
            inspect(sys.argv[2])
        elif sys.argv[1] == "download" and len(sys.argv) == 4:
            download(sys.argv[2], sys.argv[3])
        else:
            out({"error": "unknown command"})
            return 2
    except Exception as e:  # one line for the UI
        name = type(e).__name__
        msg = str(e).strip().splitlines()[0] if str(e).strip() else name
        if name == "RepositoryNotFoundError":
            msg = "Repository not found on Hugging Face (or private)"
        elif name == "GatedRepoError":
            msg = "Gated repository: accept its terms on huggingface.co and log in with `hf auth login` first"
        out({"error": msg[:300]})
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

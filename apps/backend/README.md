# @terrarium/backend

Node 24 backend: HTTP + one WebSocket on 127.0.0.1, harness runner, model gateway, env manager, trace
store, eval runner. Contract with the UI: `packages/shared/src/index.ts`. Design: `DESIGN.md`.

## Run

```
pnpm --filter @terrarium/backend dev        # node --watch src/main.ts, port 8787, token printed
pnpm --filter @terrarium/backend test       # node --test (unit + integration; e2e needs oMLX + a model)
pnpm --filter @terrarium/backend typecheck
pnpm --filter @terrarium/backend build      # tsc -> dist/ (rewriteRelativeImportExtensions)
```

Environment:

| Var | Default | Meaning |
|---|---|---|
| `TERRARIUM_PORT` | `0` (random); `8787` in `dev` | listen port on 127.0.0.1 |
| `TERRARIUM_TOKEN` | generated, printed to stderr in dev | bearer token for HTTP and WS |
| `TERRARIUM_DATA` | `<repo>/data` | sqlite, blobs, env storage, snapshots, oMLX state |
| `TERRARIUM_MODELS` | `<repo>/models` | MLX model dirs |
| `TERRARIUM_VENV` | `<repo>/.venv` | Python venv with oMLX |
| `TERRARIUM_PARENT_STDIN` | unset | `1` = exit when stdin closes (Tauri sidecar) |
| `TERRARIUM_DEV` | unset (`1` in `dev`) | allows `http://localhost:5173` origin, prints token |

Stdout carries exactly one line, the handshake `{"port":N}`. Logs go to stderr.

## oMLX install (pinned 0.7.2, 2026-10-28)

oMLX is not on PyPI. Installed from the official GitHub release wheel; the sha256 below is the
`digest` GitHub publishes for the release asset (`gh release view v0.7.2 -R jundot/omlx --json assets`).

```
cd <repo>
uv venv --python 3.13 .venv
mkdir -p .venv/wheels
curl -fsSL --proto '=https' --tlsv1.2 -o .venv/wheels/omlx-0.7.2-cp313-cp313-macosx_15_0_universal2.whl \
  https://github.com/jundot/omlx/releases/download/v0.7.2/omlx-0.7.2-cp313-cp313-macosx_15_0_universal2.whl
echo "d8f19f04ce23f7814a8b8c0264c84452e209f3d5a8e513fca9a74b176bb17982  .venv/wheels/omlx-0.7.2-cp313-cp313-macosx_15_0_universal2.whl" | shasum -a 256 -c -
uv pip install --python .venv/bin/python ./.venv/wheels/omlx-0.7.2-cp313-cp313-macosx_15_0_universal2.whl
.venv/bin/omlx --version   # 0.7.2
```

No extras installed (no `mcp`, `grammar`, `audio`, `cluster`). The wheel pins `mlx==0.32.4`, mlx-lm
`94cdcae1`, mlx-vlm `97902318`.

## How oMLX is run

`scripts/omlx_serve.py` wraps `omlx serve`:
- `OMLX_HEADLESS=1` (no web UI).
- An outermost ASGI middleware allows only the routes Terrarium calls (health, `/v1/models*`, load/unload,
  `/v1/chat/completions`, `/v1/tokenize`, `/admin/api/models`, per-model settings, generation config,
  device info, stats). Everything else returns 404, including the 0.7.2 routes that exist and are unsafe
  for this app: `/v1/mcp/*` (MCP tool execution), `/v1/web/*` (web search / fetch), `/admin/api/bench/*`
  (accuracy benchmarks that execute model-written code on the host), HF/ModelScope download and upload.
  Verified with curl against a live 0.7.2 server.
- Flags: `--host 127.0.0.1 --port <random> --api-key <random per launch> --model-dir models
  --base-path data/omlx --no-hf-cache --memory-guard-gb <budget> --sse-keepalive-mode comment
  --paged-ssd-cache-dir data/omlx/cache --paged-ssd-cache-max-size 4GB`.
- Per-model settings are applied before load: `model_type_override: "llm"`, `max_context_window`,
  `max_tokens`, sampling defaults.

oMLX sets its process title to `omlx-server`, so `pgrep -f omlx_serve` does not find it. The manager tracks
the child PID it spawned and kills that.

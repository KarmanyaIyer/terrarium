# @terrarium/backend

Node 24 backend: HTTP + one WebSocket on 127.0.0.1, harness runner, model gateway, env manager, trace
store, eval runner. Contract with the UI: `packages/shared/src/index.ts`. Design: `DESIGN.md`.

## Run

```
pnpm --filter @terrarium/backend dev        # node --watch src/main.ts, port 8797, token printed
pnpm --filter @terrarium/backend test       # node --test (unit + integration; no model needed)
pnpm --filter @terrarium/backend test:e2e   # real oMLX + Qwen3.5-4B in a sim env (~10-20 min on a busy Mac)
pnpm --filter @terrarium/backend typecheck
pnpm --filter @terrarium/backend build      # tsc -> dist/ (rewriteRelativeImportExtensions)
```

Environment:

| Var | Default | Meaning |
|---|---|---|
| `TERRARIUM_PORT` | `0` (random); `8797` in `dev` (8787 is Job Scraper) | listen port on 127.0.0.1 |
| `TERRARIUM_TOKEN` | generated, printed to stderr in dev | bearer token for HTTP and WS |
| `TERRARIUM_DATA` | `<repo>/data` | sqlite, blobs, env storage, snapshots, oMLX state |
| `TERRARIUM_MODELS` | `<repo>/models` | MLX model dirs |
| `TERRARIUM_VENV` | `<repo>/.venv` | Python venv with oMLX |
| `TERRARIUM_PARENT_STDIN` | unset | `1` = exit when stdin closes (Tauri sidecar) |
| `TERRARIUM_DEV` | unset (`1` in `dev`) | prints the generated token and a UI link to stderr |
| `TERRARIUM_LOG` | `info` | `debug`/`info`/`warn`/`error` |

Stdout carries exactly one line, the handshake `{"port":N}`. Logs go to stderr. In dev, open the printed
`http://localhost:5173/#url=...&token=...` link (the UI reads url/token from the hash).

Request gate: Host must be exactly `127.0.0.1:<port>` or `localhost:<port>`; Origin, when present, must be
`tauri://localhost`, `http://tauri.localhost` or `http://localhost:5173`; `Authorization: Bearer <token>` on
every route except CORS preflight; WebSocket `/api/ws` takes the token as subprotocol `terrarium.<token>`.
JSON bodies only (`415` otherwise), 1 MiB cap (16 MiB for `POST /api/envs` with seed files).

## Harness notes

- Model calls go through the gateway at `/s/<sessionId>/<callId>/v1/*`, which records the exact request
  JSON, raw SSE, assembled response, usage and server timing per call (`model_calls`, blobs).
- pi-ai's `streamSimple` clamps `max_tokens` to `window - estimate - 4096` (0 to a few dozen tokens on an
  8K window once a session grows). The harness calls the openai-completions adapter's `stream` directly
  with `max_tokens = min(session max output, window - prompt - 64)`, prompt from the last server
  `prompt_tokens` ratio (`harness/budget.ts`). Test: `harness/stream.test.ts`.
- oMLX withholds tool-call markup it cannot parse and fails the response with `incomplete_tool_call` /
  `invalid_tool_call`. The harness retries such a call up to 2 times and emits a `warning` (code `other`)
  each time. Text tool calls that do reach us (`<tool_call>` JSON, qwen3_coder XML, Gemma markup, bare
  JSON) are repaired with a `harness_repair` event.
- Compaction is deterministic: shorten old tool outputs to head/tail, then drop the oldest turns and note
  it on the task message. `compaction` event each time it changes the context.
- Files: manifest before/after each `bash`/`write`/`edit`; changed text files up to 2 MiB stored as blobs
  with unified diffs (`fs_change`); the manifest is stored at that event's seq for `tree?at=`/`file?at=`.

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

The packaged app doesn't use `.venv`: `scripts/package.sh` installs the same wheel and the packages pinned in
`scripts/python-requirements.txt` into a standalone CPython inside the bundle. Regenerate that file when `.venv` changes.

No extras installed (no `mcp`, `grammar`, `audio`, `cluster`). The wheel pins `mlx==0.32.4`, mlx-lm
`94cdcae1`, mlx-vlm `97902318`.

Vendored mlx-lm models: `scripts/vendor/mlx_lm_models/*.py` (now `lfm3.py`, from mlx-lm PR #2016 at
`a1de292b`, unmerged; provenance in its header, review in `TODO_20.md`). `src/inference/vendor.ts` copies them
into `.venv/lib/python3.*/site-packages/mlx_lm/models/` before oMLX starts and before each Add model check, so
a rebuilt venv gets them back with no extra step. It is idempotent, updates an older vendored copy, and never
overwrites a file mlx-lm ships itself (no `# Vendored by Terrarium` first line). When an mlx-lm release with
`lfm3` is installed, the backend logs that the vendored copy is unused; delete `scripts/vendor/mlx_lm_models/lfm3.py`
then. Upgrading mlx-lm to a release without `lfm3` keeps the vendored file (pip doesn't own it), so check it still
imports.

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
- Per-model settings are applied before load: `max_context_window`, `max_tokens` (server cap, at least the
  session's output budget), sampling defaults; `model_type_override: "llm"` for Qwen3.5 only (Gemma 4 and
  the Prism Bonsai packs need oMLX's VLM loader).

oMLX sets its process title to `omlx-server`, so `pgrep -f omlx_serve` does not find it. The manager tracks
the child PID it spawned and kills that.

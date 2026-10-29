# Terrarium

Mac app for running small local LLMs as agents in environments they can't escape, and seeing everything
they do: transcripts, exact model requests and responses, every tool call, file diffs per step, network
attempts, context usage. One-click evals across models.

## Use

Open `~/Applications/Terrarium.app` (Spotlight: Terrarium). Nothing runs until you open it; Cmd+Q stops the
backend, oMLX and every VM. Closing the window keeps runs going.

| Environment | What it is |
| --- | --- |
| VM | Linux micro-VM (Gondolin 0.14, krun, Apple Hypervisor). Alpine, python3/pip, node/npm, git, build tools. `/workspace` on the VM disk, agent runs as uid 1000. No Mac folders mounted. |
| SIM | Simulated shell (just-bash 3.6) in a sandboxed child process. In-memory filesystem, ~80 commands, Python/JS via WASM, no pip. Instant and near-zero RAM. |

Network per environment: off (default), registries (GET/HEAD to pypi, npm, GitHub, Alpine CDN), or web.
The Mac, LAN, loopback, link-local and private ranges are blocked in every mode, and every attempt is logged.

Models live in `models/` (MLX, served by oMLX 0.7.2 from `.venv`): Qwen3.5 4B/9B, Gemma 4 12B,
Ternary-Bonsai-2 2B/9B/27B.

## Develop

```sh
pnpm install
pnpm --filter @terrarium/backend dev   # 127.0.0.1:8797, prints token + UI link
pnpm --filter @terrarium/ui dev        # http://localhost:5173/#url=...&token=...  (?fixtures for fake data)
pnpm dev:app                           # Tauri window in dev
pnpm package                           # build + install ~/Applications/Terrarium.app
```

Tests: `node --test` in `apps/backend`; `guest/verify.sh` boots real VMs; `TERRARIUM_E2E=1` runs a real
model session. Guest image: `guest/README.md`.

## Layout

`apps/backend` (Node: harness, gateway, env manager, evals), `apps/ui` (React), `packages/shared` (API
types), `guest` (VM image), `evals` (suites), `src-tauri` (app shell). Runtime state in `data/`
(sqlite, blobs, env disks, images); override paths in `~/Library/Application Support/Terrarium/config.json`.
Logs: `~/Library/Logs/Terrarium/backend.log`.

Design: `DESIGN.md`. Research behind the choices: `research/`. Build record: `TODO_*.md`. Reviews: `qa/`.

# TODO_18: app UX round (settings, add model, system prompt, harness/env clarity, models + evals pages, README)

Date: 2026-10-29
Session: e2b0bb9b-da5e-49ec-b349-006ea5f60d07 (implementation sub-agent of TODO_17's "App UX round")

## TODO
- [ ] Settings page: memory ceiling, new-session defaults (model, context, thinking, harness), new-env defaults
      (type, network), saved prompt defaults; read-only paths with Reveal/Copy, disk use of data/, versions, oMLX
- [ ] Add model: suggestions + paste repo id, inspect (size, MLX, model_type vs installed mlx-lm/mlx-vlm,
      model_file), download in a separate host process with progress/cancel, oMLX re-discovery; Remove model
- [ ] System prompt: per-session view (text, tool definitions, token counts), per-session override, recorded in
      the trace (system_prompt event), save as profile default
- [ ] Harness: readable labels, hover card with prompt size, tools, when to use
- [ ] Env guidance: VM vs simulated comparison in the New env sheet + env inspector; hover help on every field
- [ ] Models page: column order and hierarchy, add/remove
- [ ] Evals page: suites overview, run config, run history, per-case results with reasons + transcript links
- [ ] Tests (backend, tsc, build), screenshots, README rewrite

## Decisions and why
- Dev data: APFS clone at /tmp/terrarium-dev-data. Rewrote the clone's snapshots.path rows and
  omlx/settings.json cache path (both held absolute paths into the real data/), so the dev backend never
  touches real data.
- Model download helper lives in apps/backend/scripts/hf_model.py (packaged with omlx_serve.py), run with
  .venv python -I and network, HF_HUB_DISABLE_TELEMETRY=1. Downloads only weights/config/tokenizer/template
  files (no .py). Compatibility mirrors mlx-lm/mlx-vlm resolution (remap tables + module present) without
  importing anything named by the untrusted config; a config with model_file (custom Python) is refused.
- oMLX picks up new/removed model dirs through POST /admin/api/reload, added to the omlx_serve.py allowlist.
- VM concurrency stays fixed at 2 (MAX_RUNNING_VMS in envs/manager.ts, other agent's file): shown read-only.

## Hurdles

## Results

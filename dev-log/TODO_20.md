# TODO 20: resource budgets and LFM3

Date: 2026-10-31. Session ID: not exposed to this implementation sub-agent.
LFM3 part: 2026-10-31 to 2026-11-01, session 148d28f1-9c49-4e18-b60a-991140ca0b48 (implementation sub-agent).

Scope: close the resource-exhaustion recommendations in `qa/CONTAINMENT.md`, then add and validate LiquidAI LFM3
through Terrarium's normal model and eval paths.

## Checklist

- [x] Read `README.md`, `DESIGN.md`, `qa/CONTAINMENT.md`, `TODO_19.md`, and the repository tool guidance.
- [x] Add persisted per-session counters for trace bytes, file captures, snapshots, network rows, model requests,
      and network bytes, with typed `budget_exceeded` trace events.
- [x] Clamp VM and sim configuration in the manager, cap simultaneous sim workers, measure worker RSS and
      cumulative CPU on the host, and enforce a host free-disk reserve.
- [x] Add the 64 MiB per-tool capture ceiling, session capture accounting, and omitted-file counts.
- [x] Add a pre-DNS HTTP token bucket and aggregate rate and row overflow records.
- [x] Validate the sim protocol, cap dump bytes and in-flight fetches, terminate on violations, and put each worker
      behind a separate parent-death guard.
- [x] Expose every tunable resource limit in Settings with one-line help.
- [x] Add hostile regression tests for counters, disk reserve, sim count/RSS/CPU, URL floods, file churn, malformed
      worker traffic, oversized chunks, fetch floods, and a killed backend with a wedged worker.
- [x] Update `qa/CONTAINMENT.md` with final file and line evidence.
- [x] Check the LiquidAI Hugging Face organization for every LFM3 text MLX build.
- [x] Audit every line of the open mlx-lm LFM3 implementation and compare it with LiquidAI's reference.
- [x] Vendor the reviewed implementation with provenance and idempotent venv installation.
- [x] Add LFM3 model discovery and suggestions, download the 8-bit model through Terrarium, and prove oMLX load
      and real-session tool calls.
- [x] Run tool-basics and coding evals on LFM3-1.7B and Qwen3.5-4B one model at a time.
- [x] Run final regression checks and commit only this task's paths and hunks.

## Decisions

- Resource settings have conservative production ranges. User values are validated in Settings and environment
  configuration is clamped again in `EnvManager`, so direct API input and old database rows cannot bypass limits.
- Session counters live in SQLite. Restarting the backend does not reset a hostile session's allowance.
- File capture bytes also count as trace bytes because the same content consumes both the capture allowance and
  trace storage. Capture planning reserves the smaller of the 64 MiB call cap and both remaining session budgets.
- Network attempts consume a token before policy or DNS work. Once a rate or row budget trips, later unique URLs
  collapse into one blank-URL overflow row instead of growing the database.
- The resource sampler enforces limits every second even with no UI clients. RSS comes from the worker PID and
  includes V8 external and WASM memory; CPU uses cumulative host process time rather than instantaneous percent.
- The sim guard is a separate responsive process. Backend pipe EOF reaches it even when the sandboxed worker is
  stuck in a CPU loop, and the guard force-kills that worker after a short grace period.

## Hurdles and fixes

- The shared checkout gained unrelated Lab files and shared-type edits during this work. Those changes remain
  unstaged; shared paths are staged by owned hunk only.
- A first base64 validator used one large regular expression. A 12 MiB hostile chunk exhausted the regex stack.
  It was replaced with a bounded character scan, and the oversized-chunk regression now completes normally.
- The normal backend suite takes about 166 seconds because one grading timeout test intentionally runs for about
  78 seconds. It completed before the new hostile cases with 229 total, 227 passed, 2 skipped, and 0 failed.

## Verification so far

- Backend and UI TypeScript checks: clean.
- Existing backend suite before the new hostile files: 229 total, 227 passed, 2 VM-gated skipped, 0 failed.
- Persisted counter and config tests: 9/9 passed.
- Manager resource and network flood tests: 6/6 passed.
- Sim supervisor hostile tests: 6/6 passed, including backend SIGKILL with a CPU-wedged worker.
- Aggregate file-capture churn test: 1/1 passed; 32 files and exactly 64 MiB captured, 1 file and 2 MiB omitted.
- Session request-budget and Settings integration, with adjacent harness tests: 17/17 passed.
- After LFM3 (2026-11-01): backend typecheck clean, backend suite 273 total, 271 passed, 2 VM-gated skipped,
  0 failed (includes 4 new `vendor.test.ts` cases); UI typecheck clean, UI tests 22/22.

## LFM3

### LiquidAI LFM3 builds on Hugging Face (HF API, 2026-10-31)

- Text, MLX: `LFM3-1.7B-MLX-4bit`, `-5bit`, `-6bit`, `-8bit`, `-bf16` (all `model_type: lfm3`,
  `Lfm3ForCausalLM`). No other LFM3 text size exists; `LFM3-1.7B-Base` has no MLX build.
- Not text-only, MLX: `LFM3-VL-2B-MLX-4bit/5bit/6bit/8bit/bf16` (`lfm3_vl`, needs mlx-vlm support),
  `LFM3-Omni-2B-MLX-4bit/8bit/bf16`, `LFM3-Audio-2B-MLX-4bit/8bit/bf16`. Out of scope.
- Add model check result (8bit): 1,855,280,680 bytes in 10 files, no problems once the vendored file is in place.

### Review of mlx-lm PR #2016 (`mlx_lm/models/lfm3.py`, head `a1de292b`, sha256 `a4096cdd...`)

- Read all 262 lines. Imports are only `dataclasses`, `typing`, `mlx.core`, `mlx.nn` and relative mlx-lm
  modules (`activations`, `base`, `cache`, `lfm2`). No file, network, subprocess, `eval`/`exec`,
  `importlib` or `__import__` use. Pure layer code plus a weight-name `sanitize`.
- Compared with LiquidAI/LFM3-1.7B `modeling_lfm3.py` and `config.json`:
  - RMSNorm is `weight * x` in both (no `1 + weight` offset), eps from `norm_eps`.
  - Attention: q/k/v/o without bias, per-head q/k RMSNorm before RoPE, scale `head_dim ** -0.5`, sigmoid output
    gate with one scalar per head (`gate_proj: hidden -> n_heads`), GQA 16/4.
  - RoPE: reference uses rotate-half over the full head dim with `inv_freq` zero past
    `partial_rotary_factor * head_dim / 2`; the PR passes `mx.fast.rope(traditional=False)` wavelengths with
    1e30 for the tail, which is a zero rotation. Same per-layer-type theta (1e6 full, 1e4 sliding).
  - Sliding window: HF `kv > q - 256` and mlx-lm `q - k < 256` are the same 256-token window; decode uses
    `RotatingKVCache(max_size=256)`, the pattern mlx-lm's gemma3 uses.
  - Sandwich norms (`post_operator_norm`, `post_ffn_norm`), SwiGLU MLP `w2(silu(w1) * w3)`, final
    `embedding_norm`, tied embeddings: all match.
  - Short conv reuses mlx-lm's `lfm2.ShortConv` (in_proj to B, C, x; `B * x`; depthwise causal conv of width 7;
    `C * conv`; out_proj), which matches `Lfm3ShortConv` for inference. The reference's packed-document
    `seq_idx` handling only matters for packed training batches.
- PR comment by pierreprudh (2026-10-30) compared it with the HF reference on CPU: bf16 weights max abs logit
  diff 1e-4, top-1 agreement 1.0, 64/64 greedy tokens; the 4bit MLX build only 0.795 top-1 agreement. That is
  why the suggestion is the 8bit build.
- Import check against the installed mlx-lm 0.31.4.dev132: the PR base's `activations.py` and `cache.py` are
  byte-identical to the installed ones, and `lfm2.ShortConv` plus the mask helpers in `base.py` are too. No
  import changes were needed. Built from the real config with random weights, a 9-token prefill plus 1 cached
  step matches the full forward (max diff 0.011 on random-init logits).

### What was built

- `apps/backend/scripts/vendor/mlx_lm_models/lfm3.py`: the PR file unchanged below an 8-line provenance header
  (PR URL, head SHA, sha256 of the PR body, license, review pointer). Placed under `scripts/` because
  `scripts/package.sh` ships that folder into the app bundle.
- `apps/backend/src/inference/vendor.ts`: copies each vendored file into
  `.venv/lib/python3.*/site-packages/mlx_lm/models/`. Called before oMLX starts (`omlx.ts`, the code that
  verifies the venv) and before each Add model check (`downloads.ts`). Idempotent; atomic rename; updates an
  older vendored copy; never touches a file without the `# Vendored by Terrarium` first line, which is how an
  upstream file is told apart. Tests in `vendor.test.ts`.
- `hf_model.py`: reports a vendored architecture as mlx-lm "... with lfm3 added by Terrarium" in
  `versions.mlxLm`, which the Add model sheet already shows, so `packages/shared` needed no change.
- Suggestion switched to `LiquidAI/LFM3-1.7B-MLX-8bit`; known-model entry (1.84 GB weights, 12,288 KV bytes per
  token for the 6 full-attention layers, 4 MB fixed sliding and conv state); family sampling from the LFM3 card
  (temperature 0.1, top_k 50). oMLX applies the card's repetition_penalty 1.1 from `generation_config.json`.

### Dropping the vendored file once mlx-lm ships lfm3

When an mlx-lm with `models/lfm3.py` is installed (through a newer oMLX wheel), `installVendoredModels` reports
`upstream` and the backend logs that the vendored copy is unused. Then delete
`apps/backend/scripts/vendor/mlx_lm_models/lfm3.py` (and the folder if empty). `vendor.ts` can stay for the next
architecture; its last test expects `lfm3.py`, so update or remove that test. Upgrading to an mlx-lm without
lfm3 keeps the old vendored file in the venv (pip doesn't own it), so check it still imports.

### Load and tool calls

- Downloaded through `POST /api/models/downloads` on a separate dev backend (port 8798, data dir
  `/tmp/t20/devdata`; 8797 was the Lab agent's backend). Only allowlisted files landed (no repo `.py`).
- oMLX discovered it as `llm`, `BatchedEngine`, 2.09 GB resident at load.
- Real session (sim env, `terrarium` harness, thinking on): read -> write -> read -> final answer "17" in 4
  turns, all native tool calls. LFM3's chat template uses the same `<tool_call><function=...><parameter=...>`
  XML as Qwen3-Coder, and mlx-lm's template sniffing picks the `qwen3_coder` parser. No parser fix needed.

### Evals (terrarium harness, thinking on, 32K context, one model loaded at a time)

| | LFM3 1.7B 8bit | Qwen3.5 4B 4bit |
| --- | --- | --- |
| Tool basics, run 1 | 9/10 (tb-top-5xx-ip hit 10 turns) | 10/10 |
| Tool basics, run 2 | 10/10 | 10/10 |
| Coding, run 1 | 4/7 graded, then cut off (see hurdles) | 3/8 |
| Coding, run 2 | 6/8 (fix-inventory, parse-duration fail) | 3/8 |
| Gen tok/s in agent runs (completion-weighted) | 33 to 45 | 20 to 39 |
| Speed suite decode / prefill 4K | 61 tok/s / 3,045 tok/s | 37 tok/s / 687 tok/s |
| Peak oMLX phys footprint over its runs | 2.63 GB | 5.36 GB |

Run ids (dev data `/tmp/t20/devdata`): LFM3 `run_mvxc6g2m6ab2f4af`, `run_mvxe0fb9d3f1c1f5`, `run_mvxcbdsdbb4c169d`
(partial), `run_mvxdg1oz4fdf57dd`; Qwen `run_mvxe4h92950c6156`, `run_mvxe7dws25cb0be2`, `run_mvxebh6g795bacad`,
`run_mvxfldp9cb268cb9`; speed `run_mvxgc5o382dd8f91` (LFM3), `run_mvxgcy06bc9e212b` (Qwen).

Notes: the machine was shared with the Lab agent's sidecar (its own Qwen3.5 4B copy) and another session's iOS
Simulator at up to 150% CPU, so tok/s figures vary by run and a first Qwen speed run (decode 30 tok/s) was
repeated when the load dropped. Both models fail coding cases on missing `ValueError` checks. Cases differ
between runs at these sampling settings: LFM3 fix-roman and implement-lru failed in run 1 and passed in run 2.
LiquidAI's card says LFM3 1.7B is not recommended for agentic coding; it still beat Qwen3.5 4B on this suite.

### Hurdles

- The first LFM3 coding run was cut off at 7 of 8 cases: the harness stops background shell commands after 30
  minutes by default, which took the dev backend down; the run was marked stopped and fix-inventory skipped. The
  backend was restarted with a 2-hour limit and the suite rerun in full.
- dcg blocked process substitution, heredoc writes into the repo and dynamic redirects; worked around with temp
  files and the Write tool.
- `/api/models` `residentBytes` is the static load size, so memory was sampled as the oMLX process
  `phys_footprint` (includes Metal buffers) every 5 s.

## Commits

- `027b6f4` resource budgets, amplification limits, sim supervisor hardening, Settings controls, and hostile tests.
- `84252c8` LFM3: vendored mlx-lm lfm3 model, venv install step, hf_model check, 8bit suggestion, known model.

# TODO 20: resource budgets and LFM3

Date: 2026-10-31. Session ID: not exposed to this implementation sub-agent.

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
- [ ] Check the LiquidAI Hugging Face organization for every LFM3 text MLX build.
- [ ] Audit every line of the open mlx-lm LFM3 implementation and compare it with LiquidAI's reference.
- [ ] Vendor the reviewed implementation with provenance and idempotent venv installation.
- [ ] Add LFM3 model discovery and suggestions, download the 8-bit model through Terrarium, and prove oMLX load
      and real-session tool calls.
- [ ] Run tool-basics and coding evals on LFM3-1.7B and Qwen3.5-4B one model at a time.
- [ ] Run final regression checks and commit only this task's paths and hunks.

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

## Commits

- `027b6f4` resource budgets, amplification limits, sim supervisor hardening, Settings controls, and hostile tests.

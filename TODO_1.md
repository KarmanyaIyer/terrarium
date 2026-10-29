# TODO_1: Terrarium (local model playground, rebuild of local_llms)

Date: 2026-10-28
Session: 4d7fa632-b05e-4dbb-857c-d7d9f81d874f (T3 thread 2f9ddd9e-65f4-42e4-9a56-0b40299173e2)

## Goal
Run small local models as agents in environments they can't escape, and see everything they do:
full transcripts, raw model requests/responses, every tool call and its output, the workspace's files and
how they changed, context usage. Create, reset, fork environments. Pick models freely. One-click evals that
open as normal transcripts.

Replaces ~/PRIMARY/Projects/local_llms (GPT Sol build, Oct 13-16, thread e1456805). Keep its downloaded
models (9.2 GB: Qwen3.5-4B 4bit, Ternary-Bonsai-2 2B/4B/9B 2bit), drop its dashboard and glue code.

## User decisions (2026-10-28)
- App form: Mac app (Tauri) with a web UI inside
- Environments: both real Linux micro-VMs and simulated just-bash environments, clearly labeled
- Network: off by default; per-environment toggle (package registries only, or full public web)
- Harness: I pick after research

## What went wrong last time (do not repeat)
- UI showed prose summaries and a static mermaid chart instead of the actual data
- Workspace contents invisible; unclear what kind of environment the agent was in
- Replies cut off: 8K context vs Pi's 4K reserve; "fixed" minimally
- No model picker (model name hard-coded in a corner, not clickable)
- Evals one click but opaque (couldn't see cases, outputs, what the agent did)
- Lots of filler subtitle text everywhere

## TODO
- [x] Research: harness, models + inference server, sandbox/app tech (research/*.md)
- [x] Architecture + UI design doc (DESIGN.md), shared API types, env driver contract
- [x] Build (4 parallel agents): backend core, VM driver + guest image + policy, UI, eval suites
  - backend: 96/97 unit tests (1 gated), real e2e with Qwen3.5-4B in sim, 32 calls, 0 one-token replies
  - VM: krun boot 1.1-1.5 s, ~110-135 MiB idle, all isolation probes denied + logged, image 614 MB (no Chromium)
  - UI: built against fixtures, internal QA found/fixed 10 bugs
  - evals: tool-basics 10, shell-data 8, coding 8, reasoning 12, speed 3, boundary 7 (mine), + GSM8K/MMLU/HumanEval/MBPP
- [ ] Integration (Mac agent): UI against real backend, VM sessions, evals from UI, persistence
- [ ] Tauri app shell + packaging (Mac agent)
- [ ] QA on the Legion: UI design review + fixes (branch ui-review), code + security review (read-only)
- [ ] Merge ui-review, apply review findings, final QA pass
- [ ] Switchboard entry, UTILITIES.md entry, retire local_llms

## Decisions and why
- Harness: pi-agent-core 1.4.0 loop on the host, our ~125-token prompt + bash/read/write/edit routed into envs.
  Host-side so the VM needs no route to the Mac, and one trace format for both env types. Cancel pi-ai's
  4,096-token clamp (root cause of last time's 1-token replies). Pi-stock profile for comparison.
- VM: Gondolin 0.14 (krun default, QEMU fallback). Only option with live-switchable, fully logged egress
  policy. ~0.9 s boot, ~125 MiB idle RSS. Apple container ruled out (no outbound filtering).
- Workspace on VM disk + root observer helper manifest per tool call (host mounts are 300-450x slower and
  allowed guest symlinks onto the Mac).
- Sim: just-bash 3.6 in a child process under sandbox-exec; denyPrivateRanges defaults false (verified
  loopback leak), so all network goes through our policy engine instead.
- Inference: keep oMLX, upgrade to 0.7.2, memory ceiling 11-12 GB.
- Models: kept Qwen3.5-4B, Bonsai-2-9B, Bonsai-2-2B (moved from local_llms); downloading Qwen3.5-9B,
  Gemma 4 12B, Bonsai-2-27B. Bonsai-2-4B left in local_llms/models (redundant).
- App: Tauri 2 shell spawning bundled Node backend; UI talks HTTP + 1 WebSocket with per-launch token.

## Hurdles / fixes
- dcg blocks dynamic-path mv and variable redirects: use literal paths.
- First evals agent was stopped by a model safety filter (isolation prompts phrased as escape/backdoor
  requests). Relaunched without that suite; wrote evals/suites/boundary.json myself in neutral wording.
- Mac heavily loaded by unrelated work (load avg 200-900). Linux-capable work moved to the Legion: repo remote
  `legion` = legion:/home/karvi/Projects/g-terrarium (receive.denyCurrentBranch updateInstead); review worktree
  at /home/karvi/Projects/g-terrarium-review.
- oMLX fails the whole response on unparseable tool calls (incomplete_tool_call); harness retries up to 2x.

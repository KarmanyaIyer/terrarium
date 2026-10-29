# TODO_3: Integration (UI against real backend, end to end)

Date: 2026-10-28
Session: a02f5647-10b3-4a92-b637-f8aeb4f920f9

Scope: make backend + VM driver + UI + evals work together through the UI; fix what breaks.
UI visual components are being polished on another branch: only touch apps/ui/src/{api,state} freely.

## TODO
- [x] Backend dev + UI dev against it; app loads real state, memory bar, oMLX start/stop
- [x] Sim env: create, Qwen3.5-4B terrarium session, multi-step task; transcript, timeline, files, diffs, scrubber
- [x] Request inspector: request/response JSON, finish_reason, usage, timings; context meter = server usage
- [x] VM env: coding task; network off/registries/web + Network tab; pip install in registries
- [x] VM env: snapshot, fork, reset, restore; facts; Shell as agent and root
- [x] Model picker switch on idle session; load/unload in Models view; memory estimate; Qwen3.5-9B once
- [x] finish_reason length warning + Continue
- [x] Chat-only session
- [x] Evals: tool-basics (4B), coding x2 (VM), boundary (all pass), speed (2 models); open transcripts
- [x] pi-stock harness in sim env
- [x] Backend restart: persistence
- [x] Backend tests, UI tsc + build
- [x] Screenshots apps/ui/screenshots/real-*.png
- [x] Stop everything (oMLX, VMs, dev servers, wb done)

## Flow results
- App load, memory bar (1 Hz), oMLX start/stop from top bar: pass
- Sim env + Qwen3.5-4B multi-step: pass (6 calls, 3 then 4 lines); diffs: fixed (blob CORS); scrubber: pass
- Request inspector + context meter: pass after run (797+531 = 1300 prompt + 28 completion); mid-run: fixed
- Top bar / Models count after auto-load: fixed (models broadcast on loaded-set change)
- VM env: boot 5 s, real facts, coding task 8/8 tests OK, pip install six in registries, example.com denied,
  live toggle registries->web->off mid-loop (6 deny, 4 allow, 4 deny): pass
- Snapshot (2 s), restore, fork from snapshot, reset to clean image, Shell as agent/root: pass
- Model switch 4B -> 9B on idle session (model_switched warning, next turn on 9B): pass
- Load/unload in Models view: pass
- finish_reason length (1K cap) + Continue: pass; chat-only session: pass
- pi-stock in sim env: pass (Pi prompt + read/bash/edit/write)
- Restart: envs, sessions, eval runs persist; transcripts, files, history to the model all restored: pass
- Session titles: fixed (all were "New session")

## Eval results (Qwen3.5-4B unless noted, thinking off, 16K)
- boundary 7/7 (twice; second run with canary-path host-file probes)
- tool-basics 10/10
- coding: 2 graded, 0/2 (fix-pagination: no ValueError checks; fix-roman: hit 20 turns), 6 skipped via UI Stop
- speed (after fixes): Qwen3.5-4B prefill 856 / 641 tok/s (1K / 4K), decode 31.3; Bonsai-2-2B 1581 / 1454, decode 92.7
- Qwen3.5-9B: one interactive turn set in a VM session (TTFT 9.1 s incl. load, 22 tok/s)

## Bugs fixed
- 63337f5 Blob route had no CORS headers: every diff in the UI stuck on "Loading diff"
- c433d21 oMLX auto-load/evict never broadcast `models`: top bar said "none loaded" while generating
- cf0b297 Boundary host-file probes could not detect a successful host read (canary path never targeted)
- cc11090 Speed: first case after a model switch timed the model load as prefill (Bonsai 1K: 102.6 tok/s)
- cbd683d ui: speed cells showed wall time instead of the measured tok/s
- 9e24e50 Speed: re-runs hit oMLX's prefix cache (3952/3959 cached, "52 tok/s"); per-run tag + cache check
- 8c131df Sessions never got a title; first message now names an untitled session
- f25348b ui: context meter stayed at the pre-run estimate until the run ended

## Decisions
- Backend run without `--watch` (a wrapper with the same env as `pnpm dev`) so edits don't kill live runs.
- Coding "2 cases": hand-written suites have no sample selector by design; ran the suite and used the
  UI's Stop after 2 graded, which is a real flow (remaining cells "skipped").
- Speed eval cells: one-line change in EvalsView (visual component) because the cell hid the result.
- Second speed model: Bonsai-2-2B (smallest, 1.1 GiB) given the memory constraint.

## Hurdles
- Load average 300+, 3-5 GiB free: kept one model loaded, at most 2 VMs.
- Confirm buttons auto-disarm after 6 s; two separate wb calls were slower than that (not an app bug).
- TaskStop signals the whole process group, so the sim worker died before its stop checkpoint
  ("checkpoint on stop failed"). SIGTERM to the backend pid alone shuts down cleanly. State survived
  either way (sim state is persisted per tool call).
- Python 3.9 system interpreter: no backslashes in f-strings; helper scripts in /tmp/terrarium-int/bin.

## Not fixed / noted
- Env facts are gathered once on first start (disk used goes stale; "Gathered" time is shown).
- Tool diff block shows "Loading diff" forever if a blob fetch fails (visual component; root cause fixed).
- Eval sessions keep an enabled composer though their env storage is released after grading.
- VM integration tests (guest/verify.sh) not re-run; `pnpm test` covers policy and unit/integration.

# TODO_11: review 3 findings 5 to 8 (env ownership, VM cap, reaper, UI catch-up)

Date: 2026-10-29
Session: 335848d6-947a-4bfa-afa4-4011a3be9082

Source: qa/REVIEW_3_delta.md, findings 5, 6, 7, 8. Another agent worked on eval grading in the same checkout at the
same time (guest grade*.py, evals/**, qa/review3-probes/**); none of its files are in these commits.

## List

- [x] #5 eval case owns its env before the fork inserts it (ec8d455)
- [x] #6 a VM holds its slot until its VMM has closed; one runtime open per env (f3ef97d, f5af179)
- [x] #7 reaper reads start times in UTC (guard too); pid-only record the moment the VMM pid is known (12839fa)
- [x] #8 UI: net log refetch never gappy; Send/Continue disabled with reason when another holder has the env;
      partial chip only when chunks were missed; eval context picker offers 128K (5ffad8a, 8196137, 6502561)
- [x] Regression tests fail on the old code, pass now
- [x] Full backend suite, real VM suite, tsc (backend, UI), vite build, real UI against the dev backend

## Changes and why

### #5 (ec8d455)
`runner.ts` picks the case env's id up front (`newId`), writes the `eval_results` row as running with that env id,
then forks with `{ id }`. Ownership (`assertNotEvalOwned`, `EnvSummary.inUse`) reads that row, so from the env's first
broadcast every user op (shell, network change, other sessions, start/stop/reset/fork/snapshot/delete) is refused.
Before, the row was written after `fork()` returned, leaving a window where the env existed but nothing owned it.

Test `envs/eval-ownership.test.ts`: fake sim runtime and fake model; every op is fired at the env the moment its first
broadcast arrives, while the case is still running. All must 409 with `env read-only|busy: eval "Tool basics" case
tb-find-port running`, no root shell command reaches the runtime, network stays off, the case still passes.
Old code: first broadcast had no `inUse`, and an intruding session took the env ("environment is busy with session
sess-intruder").

### #6 (f3ef97d, f5af179)
- `VmDriver.shutdown` clears `vm` first (no new work) but keeps a `closing` promise until `vm.close()` and the guard
  disarm finish. `holdsVmm()` = running or closing; `vmmClosed()` awaits it.
- `EnvManager.runningVms` counts `holdsVmm`. `vmSlots()` waits for closing VMMs when the cap is reached instead of
  starting a third VMM. Boot and the keepRunning restart path both use it.
- `runtimeFor` memoizes the in-flight `driver.open()` per env (`opening` map), so overlapping first uses after a backend
  restart open one runtime and the tracked one is the one that boots.

Tests (`envs/manager.test.ts`): "a VM being stopped keeps its slot until its VMM has closed..." (old: peak 3 VMMs while
B was closing) and "overlapping first uses of an env after a restart open one runtime..." (old: 3 runtimes opened for
one env). Real VM: `vm.test.ts` "stop/start persistence" checks `holdsVmm` stays true until the VMM has exited.

### #7 (12839fa)
- Every `ps -o lstart` read runs with `LC_ALL=C TZ=UTC0`; the guard script exports both itself (`GUARD_SCRIPT`), so a
  Mac timezone change between boot and check no longer changes the identity string.
- Records carry `tz: "UTC0"`; older records (no `tz`) are still compared in local time.
- `guardWhenSpawned` polls for the VMM pid every 5 ms and writes a pid-only record synchronously (tmp + rename) the
  moment the pid is known, with `since` (before `vm.start()`) and `seenAt`. The full record (identity) replaces it once
  `ps` has run. A backend killed between those two moments leaves the pid-only record.

Pid-only reap rule (`pidOnlyIsOurs`): the process now on that pid is treated as ours only if
1. its command line is a VMM of the recorded kind: `gondolin-krun-runner --config <file>` with that runner config still
   in the temp dir, or `qemu-system-*` with `-drive file=<this env's disk>,`; and
2. its start time (whole seconds, UTC) is within [since, seenAt].
Two live processes never share a pid, and macOS allocates pids sequentially (checked), so a pid only comes round after
tens of thousands of spawns. A process on that pid that started inside that window and is a VMM of that kind is the
one we spawned (or a VMM that reused the pid within the same second, which is equally an orphan of ours). Anything
else is left alone and the record dropped.

Tests (`envs/vm/reaper.test.ts`, fake runner compiled with /usr/bin/cc): UTC identities across a TZ change; the guard
under `TZ=Asia/Kolkata` still matches; a backend killed while arming leaves a pid-only record and startup reaping
stops that VMM; a pid-only record stops only a VMM of its kind started in the window (wrong kind, too early, too
late all survive); pre-UTC records still match in local time. Old code: first 4 failed (the 5th is the compatibility
case and passes on both).

### #8 (5ffad8a, 8196137, 6502561)
- Net log: `mergeNetPage` (`apps/ui/src/lib/catchup.ts`). When the fetched page is capped (rows = limit), shown rows
  older than the oldest fetched row are dropped instead of sitting above a hidden gap; rows that arrived during the
  fetch, and shown rows with a later attempt than their fetched copy, are kept.
- Partial chip: `model_delta` and `tool_output` carry a per-call chunk index `n` (gateway, harness sessions). The UI
  (`afterChunk`) marks a buffer whole only if it saw chunk 0 and every chunk after; opened during prefill = whole,
  opened mid-stream or a chunk dropped by the hub's slow-socket rule = partial. Before, the chip keyed off "saw the
  call start", so the hub's dropped chunks left silent holes.
- Send/Continue: `runBlocked(env, session)` (`lib/envuse.ts`) disables Send, the run_end Continue and the truncation
  Continue with the reason (`env busy: session "x" running`, `env read-only: eval ... running`) when `EnvSummary.inUse`
  names another holder.
- Eval picker: all of `CONTEXT_CHOICES` (up to 128K); fit estimates use min(run context, model native); a model whose
  native context is lower shows "runs at NK", and the run view says which models ran lower.

UI logic tests: `apps/ui/test/catchup.test.ts` (6). Old logic: 4 of 6 failed.

## Verification (final, at 6502561)

| Check | Result |
|---|---|
| Backend `node --test` full (working tree) | 160 tests: 157 pass, 1 fail, 2 skipped |
| The 1 fail | `evals/grade-rpc.test.ts` hybrid __eq__ test (review 2, #12): from the other agent's uncommitted `grade_rpc.py` edits; same file passes 11/11 on a `git archive HEAD` export |
| Real VM (`TERRARIUM_VM_TESTS=1` vm.test.ts + reaper.test.ts) | 27/27 pass (run after the last edit to env/VM code) |
| UI logic tests | 6/6 |
| tsc backend, tsc UI | clean |
| vite build | OK |
| src-tauri | untouched, no clippy needed |

Real UI (vite + dev backend on port 8797, temp data dir /tmp/terr11/data, Qwen3.5 4B 4bit):
- Send/Continue: session "holder" while "streamer" ran on the same env: Send disabled with `env busy: session
  "streamer" running`; run_end Continue and truncation Continue likewise; all re-enabled when the other run ended.
- Partial chip: opened 0.2 s after send (inside the 17.8 s prefill): reply streamed live, no chip at any sample.
  Opened 26 s after send (mid-reply): `partial` chip shown for the whole stream, gone when the reply ended, full reply
  shown.
- Net log reconnect: 5 old rows shown (Whole env); backend stopped; 1,200 newer rows inserted; backend restarted. UI
  showed exactly r200..r1199, none of the old rows, chip `latest 1,000` and `Load 5,000`. Load 5,000 showed all
  1,205 and removed the chip.
- Eval picker: 4K to 128K offered; picking 128K recomputes fit (Qwen3.5 9B "1.7 GiB short", Gemma 4 12B "1.6 GiB
  short"). None of the 6 installed models has a native context under 128K, so "runs at" never showed here.

## Hurdles

- dcg blocked `rm -rf` on the old-code scratch copy and `mv` of it out of the repo: used `cp -R` into the existing dir,
  then moved it to the Trash at the end.
- dcg blocked a large python heredoc rewriting reaper.ts and shell redirects to variable paths: used Edit and script
  files.
- `ps -E` can't show another process's environment on this macOS, so the guard TZ test checks behaviour (guard run
  under TZ=Asia/Kolkata still matches) rather than reading its env.
- `git commit -- <new file>` fails on an untracked path: `git add -- <file>` first.
- A 7,000-word prompt overflowed the 16K window (see below); partial-chip runs used fresh sessions with 1,500 words.
- A `git archive HEAD` export can't run the sim suites (the sim worker's sandbox profile can't load modules from
  /tmp), so only grade-rpc.test.ts was run there.

## Noticed, not fixed

- Hub drops streamed chunks for clients over 8 MB buffered: before #8 this was a silent hole; now it shows as partial.
  The drop itself remains.
- `apps/backend/src/inference/gateway.ts` (outside the owned list) got 2 lines for the chunk index.
- A failed fork leaves `eval_results.env_id` naming an env that errored or never existed.
- `startRun` in a non-eval session on an eval-owned env didn't check ownership synchronously: Send started a run that
  then errored at acquire. The UI now disables Send; the backend still accepts the POST.
- Context estimate vs real tokenization: compaction reported 30,013 tokens, then oMLX rejected with 38,909 > 32,768;
  compaction can't shrink a single message that alone overflows the window.
- With a partial chip the live counter ("131 tok") counts only chunks received since opening.
- The context bar footer showed "19.1K / 16K" with Free 0 after a long reply (server numbers: history 9,942 + reserve
  8,192 + system 993).
- Network tab header ("1,000 attempts, 1,000 denied") wraps to 4 lines in the default inspector width.

# Review 2: final regression review (independent, Opus 5.5 on the Legion, 2026-10-29, commit f47fc4a)

Scope: everything since f107753 (REVIEW_1 fixes, integration, packaging). Codex did a correctness pass, Grok a UI
pass; the reviewer reran every finding below that would change a verdict.

Status: open.

## High
1. **Grader can't see a function mutating its caller's arguments.** `guest/.../grade_rpc.py:94-101` copies args by
   value (sent by `CallableRef.__call__`, `:339`), so `test_caller_dict_not_mutated` in fix-inventory can never fail.
   Reference + `self.stock = stock if stock is not None else {}`: RPC grader 6/6, plain unittest 1 failure.
   Fix: pass mutable containers by reference, or copy their state back into the caller's objects after each call.

## Medium
2. **refactor-report passes without the refactor.** `grade.py:177-183` makes the graded copy agent-owned and the
   candidate runs as agent inside it; the runner then reads `report.py` from that copy (`grade_runner.py:100`, test
   line 34). Original loops + `_summarize` + "overwrite own file with refactored text on import" passes 3/3 (2/3
   without the overwrite). Fix: give the runner a root-owned, read-only copy of the sources.
3. **oMLX orphaned after a backend crash.** Exit watcher clears `pid` (`src-tauri/src/backend.rs:294`), then `stop()`
   returns before the group kill (`:326`); neither Restart backend nor Quit kills the old group. oMLX ignores stdin
   and never checks its parent (`omlx.ts:140`), so it keeps the model loaded. Fix: store pgid separately, kill it on
   unexpected backend exit, always kill in `stop()`.
4. **Session that finished while you were elsewhere shows a stale transcript.** Only the open session is subscribed;
   `loadTrace` returns early once loaded (`store.ts:426`). Fix: always fetch `after=contiguous` on open.
5. **Event history silently capped at 5000** (`db.ts:89`); `http.ts:139` never pages. Fix: page until a short page.
6. **2-VM cap still bypassable.** `snapshot()`/`restore()` on a running VM reboot inside the driver
   (`driver.ts:634,649`), outside `vmBoot`/`makeRoomForVm`; `makeRoomForVm` stops other envs without their mutex
   (`manager.ts:443`). Fix: reboot through the manager's `boot()`.
7. **Network tab can lose denied attempts.** Newest 1000 rows ordered by first `ts` (`manager.ts:166`); header counts
   rows not attempts and doesn't say rows are missing; `resync` never refetches `net` (`store.ts:217`). Fix: order by
   `COALESCE(last_ts, ts)`, page or say "latest 1000", count repeats, refetch after reconnect.
8. **Controls that always fail.** Continue and "Raise output cap" render on eval-case sessions (`Blocks.tsx:478,586`)
   but `assertNotEval` (`sessions.ts:396`) answers 409. Fix: hide when `evalRunId` is set.
9. **Truncation warning shows the wrong cap.** Reads `maxOutputTokens` (`Blocks.tsx:437`), event sends `maxTokens`
   (`sessions.ts:550`); offers "Raise output cap" when context is the real limit; `reasoningTokens` never sent.

## Low
10. VM `command` checks run as root in /workspace and pass on exit code (`graders.ts:187`); DESIGN says grader uid.
    A hand-written `python3 /grader/t.py` command check (validator accepts it, `validate.ts:51`) reopens REVIEW_1 #1.
11. Plausible: request blob stored at call start (`gateway.ts:171`) but no row names it until call end (`:202`); a
    >10 min call plus a deletion lets GC sweep the request JSON. Fix: `requestBlob` in `model_call_start`.
12. RPC mismatches with plain unittest (no cheat value): list subclasses become lists (`grade_rpc.py:115`); a too-deep
    return value reports as ValueError (`:544`); a class named `builtins.ValueError` becomes the real one (`:395`);
    fixed 30 s per-call limit ignores `--timeout` (`grade_runner.py:96`).
13. Rule 1/5 leftovers: suite description as subtitle (`EvalsView.tsx:562`); palette cuts at 40 hits silently
    (`Palette.tsx:87`); eval composer shows two explanatory sentences (`Composer.tsx:111`).

Test portability: `grade-local.test.ts:58` "fake-results" fails on Linux (temp dir under /tmp, the cheat writes a
forged results file; grade still fails but the test asserts counts).

## REVIEW_1 verdicts
Hold: 2, 3, 4, 5 (by code), 6, 8, 9, 10, 11 (by code). Partial: 1 (findings 1, 2, 10), 7 (finding 6).

## Tests on Linux (f47fc4a)
Backend 122: 97 pass, 20 fail (19 missing sandbox-exec, 1 portability above), 5 skipped. tsc clean, vite build OK,
`verify.ts` 41/41, every reference solution 599/599.

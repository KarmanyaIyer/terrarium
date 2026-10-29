# Review 2: final regression review (independent, Opus 5.5 on the Legion, 2026-10-29, commit f47fc4a)

Scope: everything since f107753 (REVIEW_1 fixes, integration, packaging). Codex did a correctness pass, Grok a UI
pass; the reviewer reran every finding below that would change a verdict.

Status: all 13 fixed (2026-10-29). Records: TODO_6.md (grading), TODO_7.md (backend/lifecycle), TODO_8.md (UI),
TODO_9.md (env busy state + VM orphans, follow-up from items the fix agents found).

## High
1. **Grader can't see a function mutating its caller's arguments.** `guest/.../grade_rpc.py:94-101` copies args by
   value (sent by `CallableRef.__call__`, `:339`), so `test_caller_dict_not_mutated` in fix-inventory can never fail.
   Reference + `self.stock = stock if stock is not None else {}`: RPC grader 6/6, plain unittest 1 failure.
   **Fixed** (25f6cd3): lists, dicts, sets and bytearrays the tests pass are linked; after each message the candidate
   sends new contents of any it changed and the test side writes them into its own object in place (during the call,
   after a raise, before a callback, later via a kept reference); aliases, cycles and identity behave as in one
   process; expected values still never reach candidate code. Tests: `grade-rpc.test.ts` (7 mutation cases),
   `grade-local.test.ts` (alias bug 5/6, matches plain unittest), `vm.test.ts` (real VM: reference 6/6, alias bug 5/6).

## Medium
2. **refactor-report passes without the refactor.** `grade.py:177-183` makes the graded copy agent-owned and the
   candidate runs as agent inside it; the runner then reads `report.py` from that copy (`grade_runner.py:100`, test
   line 34). Original loops + `_summarize` + "overwrite own file with refactored text on import" passes 3/3.
   **Fixed** (25f6cd3): `grade.py` copies /workspace to a root-owned read-only `src` before any candidate code runs;
   hidden tests read sources there, candidate runs in a separate agent-owned `ws`. Test: source-swap cheat scores 2/3
   locally and in the VM (`WROTE ws`, `denied src`).
3. **oMLX orphaned after a backend crash.** Exit watcher clears `pid` (`src-tauri/src/backend.rs:294`), then `stop()`
   returns before the group kill (`:326`). oMLX ignores stdin and never checks its parent (`omlx.ts:140`).
   **Fixed** (b87ed7d): the shell keeps the pgid separately, reaps the group (TERM, 3 s, KILL) on unexpected backend
   exit and always in `stop()`; oMLX gets a stdin pipe and a watchdog (`scripts/omlx_serve.py`) that shuts it down on
   EOF. Manual: kill -9 of the backend (standalone and under the debug Tauri binary) with a model loaded: oMLX gone in
   1 s; Restart and Quit leave no processes.
4. **Session that finished while you were elsewhere shows a stale transcript.** `loadTrace` returned early once
   loaded (`store.ts:426`).
   **Fixed** (63db599): opening a session fetches every event after the last contiguous one, merged without
   duplicates; streamed text that missed chunks shows a `partial` chip until the call ends. Verified live (A finished
   while on B; mid-reply leave and return).
5. **Event history silently capped at 5000** (`db.ts:89`; the UI client never paged).
   **Fixed** (358e7a2): `GET /api/sessions/:id/events` without `limit` returns the whole history in 5000-event pages.
   Test: `http.test.ts` "review 2, #5" (12,345 events).
6. **2-VM cap still bypassable** via snapshot/restore reboots inside the driver; `makeRoomForVm` stopped other envs
   without their mutex.
   **Fixed** (28f222c): the driver stops and leaves the VM stopped; the manager holds the boot lock from before the VM
   goes down until it's back up (snapshot, fork, create's factory snapshot, reset); making room stops an idle VM under
   its own mutex outside the boot lock, then recounts; seeding holds the env mutex. Tests: 4 new in `manager.test.ts`
   (interleavings, deadlock, seeding vs making room); real-VM run peak 2.
7. **Network tab can lose denied attempts.** Ordered by first `ts`; header counted rows; no "missing" indicator; no
   refetch after reconnect.
   **Fixed** (63dae6a server, 63db599 UI): ordered by `COALESCE(last_ts, ts) DESC`; header counts attempts and denied
   attempts; `latest N` chip plus "Load 5,000" when capped; reconnect refetches; rows sort by `lastTs ?? ts`. Test:
   net-log block in `gc.test.ts`; verified live (11 attempts over 5 rows).
8. **Controls that always fail** (Continue, Raise output cap on eval sessions; backend 409).
   **Fixed** (374dc46, 63db599): hidden on eval sessions along with Raise context window and Turn off thinking; header
   model/harness/thinking/network switches read-only there (backend `update()` 409s anything but a rename); released
   eval envs hide Start/Snapshot/Fork/Reset/Restore (`EnvSummary.released`). Test: `sessions.test.ts`.
9. **Truncation warning shows the wrong cap**; `reasoningTokens` never sent.
   **Fixed** (374dc46, 63db599): the warning carries the call budget, session cap and `reasoningTokens` (oMLX reports
   them; the gateway already parsed them). "Context window full" offers Raise context window; cap-limited offers Raise
   output cap only when it would raise it. Verified with a real 4K run.

## Low
10. VM `command` checks ran as root in /workspace and passed on exit code; `python3 /grader/t.py` was accepted.
    **Fixed** (25f6cd3, d58bf36): command checks go through `grade.py --command`: kill agent and grader processes,
    then `bash -c` as uid 1000 in /workspace with a root-owned PATH and empty HOME; never root or grader. The validator
    rejects command checks that mention /grader or carry hiddenFiles, and hand-written suites are now validated on load.
    Tests: `suites.test.ts` (rejection, bad suite rejected on load), `graders.test.ts`, `vm.test.ts` (uid 1000, can't
    read /grader, ignores a `~/.local/bin` shim, agent daemon dead first).
11. Plausible: request blob unreferenced between call start and end; GC could sweep it on a >10 min call.
    **Fixed** (d2c11a7): `model_call_start` carries `requestBlob`. Test: `gateway.test.ts` "review 2, #11".
12. RPC mismatches with plain unittest.
    **Fixed** (25f6cd3): subclasses of built-in data types keep type and methods (a correct `LRUCache(OrderedDict)` used
    to score 1/6); a too-deep return value raises `Unsendable` (a BaseException `assertRaises` can't catch); a fake
    `builtins.ValueError` is reported as `builtins(redefined).ValueError`; one call may use the whole `--timeout`.
    Tests: `grade-rpc.test.ts`. Also fixed: proxy field names shadowing candidate `_id`/`_c`, NUL in a class name,
    OrderedDict order, a candidate process dying inside `assertRaises(Exception)` counting as a pass.
13. Rule 1/5 leftovers (suite description subtitle, palette cut at 40, eval composer sentences).
    **Fixed** (e748902): description is a tooltip; palette scrolls (72 rows checked); eval composer shows
    `eval case · read-only · env released`; sweep removed 3 more explanatory lines and made tooltip lists say "N more".

Test portability (`grade-local.test.ts` "fake-results" on Linux): **Fixed** (25f6cd3): the cheat writes only its own
`../out/results.json` on both platforms; `grade.py` ignores a results file when the runner exited non-zero.

## REVIEW_1 verdicts
Hold: 2, 3, 4, 5 (by code), 6, 8, 9, 10, 11 (by code). Partial: 1 (findings 1, 2, 10), 7 (finding 6). Both now fixed.

## Tests after fixes (macOS)
Backend `node --test`: 147 tests, 146 pass, 1 skipped (gated e2e). Real-VM suite 17/17; `guest/verify.sh` policy
16/16, VM 18/18. `verify.ts` 41/41; datasets GSM8K 1319, MMLU 2524, HumanEval 164/164, MBPP 427/427 references pass.
tsc clean (backend, UI), `vite build` OK, `cargo clippy` 0 warnings.

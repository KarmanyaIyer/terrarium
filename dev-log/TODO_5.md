# TODO_5: Review 1 fixes (code + security) and integration leftovers

Date: 2026-10-28
Session: 687bbecb-606f-4d77-8212-3ef3ab5317af (implementation sub-agent)

## TODO
- [x] #1 grading integrity: `tests` check type, guest grade.py (agent worker + grader runner over RPC), coding/HumanEval/MBPP converted, cheat tests
- [x] #2 safe guest reads (read.py, O_NOFOLLOW, S_ISREG, caps, timeout) + FIFO/zero/symlink test
- [x] #4 per-exec cgroups, kill-user agent at run end and before grading + setsid test
- [x] #3 sim proxy: policy before DNS + test
- [x] #5 sim checkpoint pieces, old-format split, failed save in stderr + 13 MiB test
- [x] #7 VM boot lock, seeding through managed start + concurrency test
- [x] #8 malformed percent-escape 400 + test
- [x] #9 net repeats (migration 002), manifest deltas, blob GC + tests
- [x] #10 answer parsing (finalChoice/finalNumber) + tests
- [x] #11 deny-default sandbox profile + test, sim e2e under it
- [x] Leftovers: facts on every start and reset; diff error + retry; eval composer read-only; first-N cases for hand-written suites
- [x] Guest image rebuilt (0abf4e59), interim 720adb61 trashed, verify.sh 17/17 + 16 policy
- [x] Backend tests, UI tsc + build, gated e2e (Qwen3.5-4B)
- [x] Evals via API: boundary, coding, tool-basics
- [x] Grader fixes found by the evals: file `equals` accepts an optional final newline; failure summaries show the exception line
- [x] Image rebuilt again (f4eb0f00), 0abf4e59 trashed, verify.sh rerun
- [x] Package, install, launch against real data, quit
- [x] Final report

## Decisions
- Grading splits candidate and tests into two processes and two uids instead of only dropping privileges: with
  the tests in the candidate's process, any candidate can patch `unittest` or exit 0. The RPC passes plain values
  by value and everything else by reference, and refuses ref-vs-local comparisons, so an "always equal" object
  can't satisfy assertEqual against an expected value it never sees. Stdlib names in MBPP tests resolve on the
  test side (`terrarium_grading.stdlib`), candidate names through the proxy module.
- Helper migration by content hash, not a VERSION number: any helper edit reaches old envs at their next boot.
  Existing envs and the eval base VM stay on image 37190e93 and migrate this way.
- Root reads never follow symlinks; agent-facing reads follow them but run as uid 1000.
- Net repeats: collapse any identical decision (not only denials) within 60 s, sum bytes; trace keeps the first.
- Manifest deltas against the session's previous save, a full copy every 16; GC marks manifest chains and file
  entries, plus any 64-hex token in event payloads (over-marking is harmless). Startup GC grace is 60 s, not 0,
  in case two backends share the data dir; BlobStore.put/touch refresh mtime so a reused blob survives a sweep.
- VM create no longer seeds in the driver; the manager seeds through its own start/stop so the cap and lock apply.
- Facts are dropped on a reset of a stopped env (shown as "not gathered yet") instead of showing stale facts.
- Fork-from-case-setup for eval sessions skipped: it needs the suite case's seed files and a new session API.

## Hurdles
- dcg blocked inline python heredocs with mv/redirect patterns: edits went through script files in /tmp/terrarium-fix.
- `timeout` isn't on macOS; dropped from scripts.
- RPC request key `op` collided with the comparison operator argument: renamed `how`.
- mbpp-596 used `sys` without importing it: stdlib names now resolve test-side.
- Deny-default profile: node aborts (SIGABRT, no log) without read access to `/` (its cwd). Found by bisecting rules.
- `assert.deepEqual(x, [])` narrows x to never[] for tsc; used length checks.

## Results
- Backend: 122 tests, 121 pass, 0 fail, 1 skipped (real dataset cache not downloaded). Typecheck clean.
- guest/verify.sh on image f4eb0f00: 16/16 policy, 17/17 VM (incl. grading cheats, setsid kill, FIFO/zero reads, migration).
- evals/scripts/verify.ts: all suites pass. verify_datasets.ts: gsm8k 1319, mmlu 2524, humaneval 164, mbpp 427, 0 failures.
- UI: tsc clean, vite build ok. Gated e2e (Qwen3.5-4B, sim, Python WASM): pass in 101 s.
- Evals via API, Qwen3.5-4B-MLX-4bit, terrarium harness, 16k context, real data/:
  - boundary 7/7 (twice: before and after the last grader change).
  - coding 1/8 (refactor-report passes). The 7 failures are the model's: each final workspace rebuilt from the
    trace gives the same counts under plain `python3 -m unittest` and under the grader (4/5, 5/6, 2/3, 1/4,
    0/0 SyntaxError on import, 1/3, 1/2). Examples: pagination never raises ValueError; to_roman(14) = 'IXV'.
  - tool-basics 9/10, then 10/10 after the grader fix (tb-top-5xx-ip wrote the right IP without a newline).
  - first-N: `coding` with sampleSize 1 ran exactly the first case.
- Startup GC on the real data dir removed 7 blobs; none were named by the DB or by any other blob (checked against
  a backup in /tmp/terrarium-fix).
- Package: ~/Applications/Terrarium.app built and installed; launched against data/: 3 envs, 5 sessions, 70 eval
  forks shown; sim-1 file view started a sim worker under the deny-default profile with the bundled node; Cmd+Q left
  no backend, oMLX, VM or sim processes.

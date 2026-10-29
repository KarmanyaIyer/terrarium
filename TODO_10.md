# TODO 10: dual grading for `tests` checks, review 3 grading findings (1, 2, 3, 4, 9)

Date: 2026-10-29. Session: b2325895-3721-4138-a873-63bd7ddeefcc.

Decision (from qa/REVIEW_3_delta.md, not relitigated): grade every `tests` check twice, isolated (RPC) and
plain in-process unittest; pass only when both pass with passed == expected > 0; disagreement is a grader
error showing both runs.

## List
- [x] Baseline: review 3 probes under the old grader (perf_records ~30 s, perf_records6k ~115 s, perf_keep
      12 s, perf_big 13 s; lru_bug, od_eq, oneway_pass, stale_tuple, grid passed or failed differently from
      plain unittest)
- [x] grade.py: three copies before any candidate code (src sealed, ws, plain/ws in a root-only dir), isolated
      run, then plain run as agent, verdict pass/fail/disagree
- [x] Finding 2: seal() removes symlinks (never followed); copies never depend on the live workspace
- [x] grade_runner.py: `--plain` mode (watchdog writes counts at the deadline), Results class, current test
- [x] grade_rpc.py v2: findings 1, 3, 4, 9 (below)
- [x] Backend: `Grade.error`, `testsGrade()` shared by graders.ts and evals/scripts/grade_local.ts, runner.ts
      status `error` for grader errors, "... N more" for failures past 12, exec timeout 2 x timeout + 90 s
- [x] Tests: graders.test.ts, grade-local.test.ts, grade-rpc.test.ts, new grade-probes.test.ts, vm.test.ts
- [x] Docs: DESIGN.md evals section, guest/README.md grade.py section
- [x] Verification (numbers below)
- [x] Commits (path-limited): f3ee7f1 grader, 6f00f58 backend + tests, then docs + this file

## What changed in grade_rpc.py (v2)
- Finding 1, hybrids: per-class policy from the dunders the class overrides. Overridden `__contains__`,
  `__getitem__`, `__len__`, `__iter__`, `__bool__`, `__reversed__`, `__hash__`, `__missing__` go to the
  candidate (as in one process); overridden `__eq__`/`__ne__` count only when the candidate and the local data
  agree. In-place ops on mutable hybrids go to the candidate. Immutable hybrids (tuple subclasses) re-read data
  after every candidate message (stale_tuple). OrderedDict/Counter/defaultdict keep their local base.
- Finding 3, sync cost: links are checked by a shallow identity snapshot (`changed()`), not re-encoded. Test side
  checks the links it still holds and drops the rest (refcount at the calibrated floor), candidate side checks
  touched + held links. Sync time capped (SYNC_SHARE 0.25 of the budget, 5-30 s), past it CandidateGone: a
  grader error, not a timeout.
- Finding 4, shared containers: sync both ways before every message (test-side changes pushed before each
  request: oneway_pass / oneway_clobber now match plain), containers nested in linked ones get their own
  (candidate-assigned negative) link ids, per-message aliasing for by-value containers (grid's shared rows).
- Finding 9: namedtuple and defaultdict (with factory) cross with their types; test callback exceptions arrive
  as the same class (ExceptionTypes shared); candidate SystemExit is a real SystemExit with code; `issubclass`
  op between Refs; NaN: separate NaNs stay separate, one NaN sent twice in a message stays one object;
  failures past 50 counted in `moreFailures`.

## Decisions and why
- Isolated runs first: the plain run's candidate can read the hidden tests (it shares their process), so it
  must not run while anything that could leak to the isolated run is alive. The isolated run's ws and results
  are deleted and every agent/grader process killed before the plain run starts.
- Plain run as the agent uid (no new user): after the isolated run its counts are already read; the plain dir
  is root-only (0700) until the plain run starts, then 0711 with a root-owned copy of /grader.
- Disagreement -> `Grade.error = true` -> cell status `error` (existing EvalCellStatus, existing UI icon and
  tooltip). No UI change.
- Held-both-sides case (qa/review3-probes/perf_held6k: 12000 linked containers kept by both sides through 6000
  calls) stays quadratic: about 0.25 us per held link per message on each side. A batched C-level check
  measured only 1.8x faster (1.8 ms vs 3.2 ms per message at 12000 links), not worth the complexity. It hits
  the sync cap and shows as a visible disagreement (5.4 s at --timeout 20, 35 s at 120).
- Liar test (review 2): an overridden `__contains__` returning True now passes assertIn, as in plain unittest;
  the lying `__eq__` still fails in the isolated run, so that case is a disagreement (grader error).

## Hurdles
- dcg blocked heredocs containing "unlink", `rmSync` and template literals: used the Edit tool.
- tuple/int subclasses can't be weakly referenced: immutable hybrids cached in a strong dict per client.
- seal(local=True) can't chown on the Mac: local mode only strips links.

## Verification (2026-10-29)
- Probes (qa/review3-probes, 17 dirs): all 16 original probes give the plain unittest verdict with both runs
  agreeing; perf_held6k is a visible disagreement (sync cap). Same in a real VM (vm.test.ts).
- Probe times, isolated run, --local: perf_records 0.21 s (was ~30 s), perf_records6k 0.47 s (was ~115 s),
  perf_keep 0.15 s (was 12 s), perf_big 0.96 s (was 13 s). In the VM, whole grading per probe 0.9-2.0 s.
- Symlink variant of review 2 #2: old grader 3/3 pass, new 2/3 fail (local and VM).
- graders.test.ts 9/9, grade-local.test.ts 9/9, grade-rpc.test.ts 13/13, grade-probes.test.ts 2/2.
- VM (TERRARIUM_VM_TESTS=1, boot + grading tests): 4/4. guest/verify.sh: policy 16/16, VM 19/19, no
  leftover VMMs (2 min 9 s).
- Full backend `node --test`: 168 tests, 160 pass, 6 fail, 2 skipped. The 6 failures are in the other agent's
  uncommitted work (harness/compaction.test.ts 4, harness/sessions.test.ts 1, envs/eval-ownership.test.ts 1);
  every evals test passes.
- evals/scripts/verify.ts: 41/41 ok (references pass, os._exit cheats fail).
- verify_datasets: gsm8k 1319, mmlu 2524, humaneval 164, mbpp 427 items, 0 failures (49 s).
- tsc backend: 50 errors, all in src/harness/** (the other agent's uncommitted work), none in grading files.
- Coding references in a real VM, grade.py alone, median of 3: old 0.33 s, new 0.52 s per case (isolated
  0.18-0.55 s + plain 0.18-0.24 s); via gradeTests (with kill + hidden files) about 1.0 s per case.

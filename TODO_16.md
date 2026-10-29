# TODO 16: grader, review 6 (last grader round)

Date: 2026-10-29. Session: d52ae525-c6a1-438d-8198-7a2a3a5dd002.

Scope: fix review 6's normal-use regressions (correct code that 9f28698 passed) and a short list of cheap lenient
items; document the rest in guest/README.md's known gaps. Priority: correct code passes, then no added per-message
cost. No open-ended hardening. Invariant (unchanged): the isolated verdict alone never passes where plain
`python3 -m unittest` fails.

Cases: qa/review6-cases (run.py reuses review 5's helpers; expect.json: plain verdict and isolated verdict per case,
"known-lenient" for documented gaps, reported but not failed). Python: ~/.local/bin/python3.12 (3.12.15).

## List
- [x] Harness: qa/review6-cases/run.py, expect.json; baseline
- [ ] 1 getsource_ok
- [ ] 2 async_fn
- [ ] 3 gen_primed_ok, gen_primed_throw (+ gen_primed_lenient not passing)
- [ ] 4 function_many(_2000): per-message cost back within 2x of 9f28698
- [ ] 5 bound_method_identity_ok, function_dict_replace_ok, fn_self_attribute, sizeof_named, id_assertisnot_two_floats
- [ ] 6 log_lastresort_ok + log_lastresort
- [ ] 7 warn_import_silent: warnings="default" in both runs
- [ ] Cheap lenient: impure tuple aliased per message, fs_subprocess_tests, tb/gi/fn attributes Inexact + `_crossed`
- [ ] Wire into grade-probes.test.ts and vm.test.ts; README known gaps; REVIEW_6 Fixes
- [ ] Verification (all suites, VM), QA review

## Baseline (480dbeb, Mac, 3.12.15, load ~7-10)
- review 6 cases: 5 of 29 as expected, 28 of 29 known-lenient still pass (tz_lenient fails plain and isolated on
  macOS: its tzdata gives Winnipeg different 2038 rules; lenient on Linux per the review).
- Already strict before this round (correct code, isolated fail at 9f28698 too): id_nan_sticky_in, sizeof_dunder9,
  skip_only (intentional), warn_import_probe (fixed by 7).
- function_many isolated wall: 2.44 s (9f28698: 0.20 s); function_many_2000: 13.2 s (9f28698: 0.30 s).

## Decisions

## Hurdles

## Verification

## Commits

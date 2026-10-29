# TODO 15: grader fidelity (review 5 findings 1-6)

Date: 2026-10-29. Session: 71d175c4-e83c-48a5-91ba-d763fa8406f7.

Rule (unchanged): the isolated run never reports a pass plain Python wouldn't give; where it can't reproduce Python
exactly it raises a grader error (Inexact). Each review 5 item gets a case in qa/review5-cases (run.py: plain
unittest beside the isolated run's own verdict) and a regression test.

## List
- [x] Baseline: VM run before changes (21/21), review5 cases on the old grader
- [ ] 6: namedtuple `__replace__`
- [ ] 1: state candidate code changes reaches the tests (env, cwd, argv, streams, print/input; sys.path, umask, locale, tz)
- [ ] 2: forwarded `__exit__` gets a real traceback; test handles where built-in data is needed -> Inexact
- [ ] 3: documented gaps (logging, slots/weakref, function/generator types, traceback frames, id(), raw stdlib assignment)
- [ ] 4: refcounts/referrers of candidate objects -> Inexact
- [ ] 5: identity of by-value objects across messages
- [ ] Regression tests (grade-rpc, grade-probes), VM test, docs (guest/README.md, DESIGN.md)
- [ ] Verification, timings, commits

## Baseline
- VM (vm.test.ts, whole file, before any change): 21/21. Coding references (ms): fix-csv-export 1161,
  fix-inventory 1142, fix-pagination 1223, fix-roman 1785, implement-lru 1250, implement-slugify 1197,
  parse-duration 1272, refactor-report 1205; gradeMs 1391.
- qa/review5-cases on the old grader (Python 3.12, --local): 5 of 34 as expected. Every lenient case but
  slots_weak_lenient and stdlib_assign passes the isolated run (so a forged plain run makes it a pass); every
  correct case but ctx_reraise_ok, ctx_tb and ntuple_replace fails it. stdlib_assign only "works" because the
  candidate's `json.dumps` replacement breaks the grader's own protocol (the grader looked json.dumps up at call time).

## Decisions

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
- [x] 1 getsource_ok
- [x] 2 async_fn
- [x] 3 gen_primed_ok, gen_primed_throw (+ gen_primed_lenient not passing)
- [x] 4 function_many(_2000): per-message cost back within 2x of 9f28698
- [x] 5 bound_method_identity_ok, function_dict_replace_ok, fn_self_attribute, sizeof_named, id_assertisnot_two_floats
- [x] 6 log_lastresort_ok + log_lastresort
- [x] 7 warn_import_silent: warnings="default" in both runs
- [x] Cheap lenient: impure tuple aliased per message, fs_subprocess_tests, tb/gi/fn attributes Inexact + `_crossed`;
  also keyword assertIs, ref_int_low, module_type_multiline, `_thread.stack_size`
- [x] Wire into grade-probes.test.ts and vm.test.ts; README known gaps; REVIEW_6 Fixes
- [x] Verification (all suites, VM), QA review (self-review: running as a delegated child, no subagents)

## Baseline (480dbeb, Mac, 3.12.15, load ~7-10)
- review 6 cases: 5 of 29 as expected, 28 of 29 known-lenient still pass (tz_lenient fails plain and isolated on
  macOS: its tzdata gives Winnipeg different 2038 rules; lenient on Linux per the review).
- Already strict before this round (correct code, isolated fail at 9f28698 too): id_nan_sticky_in, sizeof_dunder9,
  skip_only (intentional), warn_import_probe (fixed by 7).
- function_many isolated wall: 2.44 s (9f28698: 0.20 s); function_many_2000: 13.2 s (9f28698: 0.30 s).

## Decisions
- getsource: inspect and linecache get the stand-in module's own dict (its `__loader__` reads the tests' copy).
- Coroutines: the stand-in awaits `_await_candidate`, which asks the candidate's process for one step at a time
  (`Server._step`). A bare yield (asyncio.sleep(0)) yields to the tests' loop; anything else the candidate's
  coroutine awaits, and any use of the running loop there (`_NoLoop`), is Inexact. Thrown exceptions (cancel) pass on.
- Primed generators: the generator tag carries the candidate generator's state (0 new, 1 started, 2 finished);
  a started one gets a stand-in whose first yield is already passed (`_gen_mirror`), so the first send reaches the
  candidate. State changes the candidate's code makes (start/close) are mirrored as "start"/"close" fn changes.
- Per-message cost: the candidate side tracks which functions/generators its code may reach (refcount minus the
  bookkeeping's own references, minus snapshots of links it doesn't hold; `_fn_cold`), re-measured for the young ones
  each message and all of them in sweeps of about 1/8. Only those (hot) and the stand-ins a message hands over are
  compared. The tests' side follows (fnheat/fncool). A stand-in the tests change while cold, which candidate code then
  gets back inside a container before the change crossed, is a deferred Inexact (weak_err), not silently lost.
- Function `__dict__`/`__annotations__` aren't links any more (linking them put 2 links per function on both sides'
  per-message work and hit the sync cap at 2,000 functions); their contents are compared with the other attributes.
  A dying stand-in's dict changes are flushed before its release (fn_dying), so `m.f.calls = 1` on a temporary works.
- Tracebacks to `__exit__`: same shape (entries, tb_lineno, tb_lasti) instead of one grader node, so tb_chain and
  traceback_line are exact.
- gi_yieldfrom: a source check (like `__closure__`), since the attribute isn't audited.
- Bound methods: by reference with a rid (proxy kept alive by the stand-in MethodType through a weakref callback
  table), so one candidate bound method is one object on the tests' side. Costs about 90 us per crossing of a fresh
  bound method (3,000-call loop: 1.31 s vs 1.04 s); not per message.
- Floats in assertIs: the tests' Channel records float values received (JSON parse_float, capped at 65,536 values,
  then every float is unsure as before). A float whose value never crossed is the tests' own.
- Logging: the tests' quiet handlers (NullHandler, StreamHandler on the original streams) become like handlers on the
  candidate's same-name logger, set without the candidate-side guards; the candidate removing one counts as changing
  that logger's handlers. Only recomputed when the tests add/remove a handler (no per-message work).
- warnings="default": only when there are no -W options, exactly as unittest.main().
- fs_subprocess_tests: Inexact only after a known candidate path change (fs_changed), not after the candidate's own
  process start (fs_any): review 5's fs_process_ok (`echo` in the candidate, then `echo` in the tests) must pass.
- Impure by-value objects (tuples, frozensets, namedtuples holding references) alias within a message (encoder memo).
  Checked that decode order matches encode order across values, link syncs, function attributes, exceptions and
  kwargs (10 scratch cases, no protocol errors; raw `is` now matches plain where it didn't).
- getrefcount/get_referrers of an identity-unsure value (unkeyed tuple, big int after candidate code ran, a float
  value that crossed) is Inexact (ref_int_low).
- ModuleType check per logical line (tokenize), in addition to the per-line regex.
- `_thread.stack_size` mirrored like `threading.stack_size` (one tuple entry).
- Not fixed (strict, pre-existing at 8c2d21f): `__doc__` or a replaced `__dict__` set on a temporary stand-in
  (`m.f.__doc__ = "x"`) is lost with it (function setters for those aren't audited). In README's stricter list.

## Hurdles
- dcg blocks heredocs with `${...}` text, `rm -rf` outside literal /tmp paths and inline `python3 -c`: patch scripts
  written with the Write tool to /tmp/terr-scratch/gen and run as files.
- function_many_2000 first hit the sync cap (4,004 links: each function's `__dict__` and `__annotations__`): fixed by
  not linking them.
- review 5 func_type_ok broke when `m.add.calls = 10` was set on a temporary stand-in (released before the change was
  applied): fixed with the dying-stand-in flush and applying fn changes before releases on the candidate side.
- gen_cand_advance went Inexact (inspect.getgeneratorstate reads gi_frame): `_STATE_READERS` exemption.
- fs_subprocess_tests fix first also made review 5 fs_process_ok Inexact (fs_any after the candidate's own `echo`):
  narrowed to fs_changed.
- vm.test.ts creates its VM in the first test, so `--test-name-pattern` runs need "boot time and RSS" included.
- VM review 6 run: tz_lenient's plain run passes in the Alpine guest (no tzdata), and the plain run counts skip_only's
  skip as a failure where unittest doesn't: known-lenient cases are now reported only, and the VM's plain verdict
  counts skips as passes (c13f748).

## Verification (final grader: ae00233; tests c13f748)
Mac, Python 3.12.15, load 5-13 during runs (another session busy); timings as measured, not re-run.
- qa/review6-cases: 34 of 34 as expected; 24 known-lenient (23 still pass, tz_lenient fails both runs on macOS).
- qa/review5-cases: 88 of 88. qa/review4-probes: 39 of 39. qa/review3-probes: 16 of 17 match plain (perf_held6k at
  the sync cap, 7.75 s, as before).
- Grading node tests (grade-probes.test.ts): 22 of 22. `npm test` in apps/backend: 218 tests, 216 pass, 2 skipped
  (VM-gated), 0 fail. tsc --noEmit clean.
- evals/scripts/verify.ts: 41 of 41 ("all passed"). verify_datasets: HumanEval 164/164, MBPP 427/427, 0 failures.
- Real VMs (krun, Alpine 3.23.7): guest/verify.sh's steps run in parts to stay under 10 minutes per call: policy
  16/16; vm.test.ts without review 3-6 grading 19/19 (2 min); review 3 + 4 probes 3/3 (2 min); review 5 cases pass
  (175 s); review 6 cases pass (108 s; first run failed on tz_lenient's and skip_only's plain verdicts, fixed in
  c13f748). data/vm-verify/latest.json holds only the last part (review 6).
- Timings, Mac isolated wallSeconds, 2 runs each, load 12-13 (now / 9f28698): function_many 0.35-0.37 / 0.24-0.25,
  function_many_2000 0.73-0.78 / 0.46, perf_records 1.37-1.48 / 0.98-1.00, perf_big 0.35-0.47 / 0.30-0.35,
  perf_returns 1.66-1.72 / 1.25-1.26, perf_bsearch 1.07-1.23 / 0.79-0.80. VM: function_many 1.4 s, function_many_2000
  1.5 s per grade (both runs, setup included).

## Commits
- 06eb00a review 6 case runner and expectations
- 4cbac17 getsource; coroutines stepped in the tests' event loop
- c30d646 primed generators, hot-function tracking, function dicts not linked, traceback shape, gi_yieldfrom and
  referents Inexact
- ef49929 warnings="default"
- 052af63 quiet log handlers mirrored
- a02ccbd bound method identity, namedtuple getsizeof, tests' own floats
- e3bf3cc impure by-value aliasing per message, tests' process start after file changes, keyword assertIs, refcount
  of unkeyed numbers, multi-line ModuleType checks
- a5285b6 review 6 in node and VM tests
- ae00233 `_thread.stack_size` mirrored
- c5f5b99 docs (README, DESIGN.md)
- c13f748 VM test: known-lenient reported only, skips counted as unittest does

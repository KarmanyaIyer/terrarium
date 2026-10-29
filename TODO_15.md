# TODO 15: grader fidelity (review 5 findings 1-6)

Date: 2026-10-29. Session: 71d175c4-e83c-48a5-91ba-d763fa8406f7.

Rule (unchanged): the isolated run never reports a pass plain Python wouldn't give; where it can't reproduce Python
exactly it raises a grader error (Inexact). Each review 5 item gets a case in qa/review5-cases (run.py: plain
unittest beside the isolated run's own verdict; expectations in qa/review5-cases/expect.json, shared with the node
and VM tests) and a regression test.

## List
- [x] Baseline: VM run before changes (21/21), review5 cases on the old grader
- [x] 6: namedtuple `__replace__` (085dfe2)
- [x] 1: state candidate code changes reaches the tests (env, cwd, argv, streams, print/input, umask, locale, tz;
      sys.path from the tests; C-level settings) (085dfe2, 338f944, 4d62933)
- [x] 2: forwarded `__exit__` gets a real traceback + frame guard; test handles where built-in data is needed -> Inexact (085dfe2)
- [x] 3: documented gaps: logging, slots without `__weakref__`, function/generator/module stand-ins, traceback
      frames, id(), raw stdlib assignment, type hints, re-import (2dd3a2c, 9b90cea, 3df1d9a)
- [x] 4: refcounts/referrers/process-wide counts of shared objects -> Inexact (b9bcd0b)
- [x] 5: identity of by-value objects across messages (338f944), assertIs guard for unkeyed ones (3df1d9a)
- [x] Regression tests (grade-probes review 5 tests), VM test, docs (guest/README.md, DESIGN.md, grade_rpc docstring)
- [x] 1 (found while profiling): files the candidate's code changes in its copy of the workspace. The tests run in a
      sealed copy, so a candidate writing `out.csv` on a dry run passed `assertFalse(os.path.exists("out.csv"))`
      (fs_write_lenient). Now Inexact when the tests look at a changed path (4d62933, a09421b)
- [x] Per-call cost back to the pre-session level (it had risen about 60%) (31edaa1)
- [x] Found in verification: the MBPP 596 reference (`sys.getsizeof` of a tuple the tests pass) failed: b9bcd0b made
      the candidate's getsizeof of any shared object Inexact. Now only where a copy's size can differ (6d526bf)
- [x] Found in review: a grading error caught by a bare `except:` let a run pass (caught_inexact_lenient,
      caught_cand_lenient passed the old isolated run and a forged plain one) (6d526bf)
- [x] perf_held6k syncs 24% more containers in its cap than before the session: short lists compared in Python (6d526bf)
- [x] Verification, timings, commits

## Baseline
- VM (vm.test.ts, whole file, before any change): 21/21. Coding references (ms): fix-csv-export 1161,
  fix-inventory 1142, fix-pagination 1223, fix-roman 1785, implement-lru 1250, implement-slugify 1197,
  parse-duration 1272, refactor-report 1205; gradeMs 1391.
- qa/review5-cases on the old grader (Python 3.12, --local): 5 of 34 as expected. Every lenient case but
  slots_weak_lenient and stdlib_assign passes the isolated run (so a forged plain run makes it a pass); every
  correct case but ctx_reraise_ok, ctx_tb and ntuple_replace fails it. stdlib_assign only "works" because the
  candidate's `json.dumps` replacement breaks the grader's own protocol (the grader looked json.dumps up at call time).

## Decisions
- Raw stdlib attribute changes are seen with CPython's dict and type watchers (3.12+, ctypes), not by snapshotting:
  zero cost per message, exact. Tests' changes are mirrored to the candidate; the candidate's end the run (the tests'
  process would need the candidate's code). Import-time and lazy-import (3.15) writes are filtered by frame walk.
- Candidate functions are real functions on the test side (forwarders built from the candidate's signature), so
  `type(m.f) is FunctionType` and inspect work. Their copied attributes (name, qualname, module, doc, defaults,
  kwdefaults, annotations / `__annotate__` on 3.14+, type params) are snapshot-compared per message both ways and
  mirrored; `__code__` changes and closure/globals reads are Inexact.
- Generator functions' stand-ins return the candidate generator's stand-in at the call (code flagged CO_GENERATOR,
  built with FunctionType so 3.15 doesn't warn). A stand-in being finalized leaves the candidate's generator alone
  (weakrefs are cleared before tp_finalize, so a dead weakref tells finalization from an explicit close()).
- Impure tuples and bulk numbers still cross without identity (keying them would keep proxies alive after the tests
  drop them, which breaks weakref semantics). Instead `assertIs`/`assertIsNot` on one is Inexact unless the two
  differ in type or value, or are two NaNs from one message.
- C-level process settings: mirrored by replaying setter calls (gc, switch interval, int digits, socket timeout,
  stack size); groups that can't be mirrored (signals/timers, rlimits, priority, trace/profile, faulthandler) mark
  the group dirty and the other side's use of that group is Inexact. Setter guards cost nothing per message.
- `del sys.modules["m"]` by the tests reaches the candidate (3.12+ watcher) and a re-import re-runs the module there.
- Workspace files: the tests' copy stays sealed (it's what makes rewriting the source after the copy useless), so
  files can't be mirrored. Candidate side: an audit hook records the workspace paths its code creates, writes,
  removes, renames or chmods (realpath and as named; "*" after a subprocess, fork, exec or ctypes call not made by
  the grader), sent as cst "fs". Tests' side: audit events (open, listdir, scandir, xattr) and wrappers on os.stat,
  lstat, access, readlink (os.path and pathlib go through them) raise Inexact when the tests' code looks at a changed
  path, one inside a changed directory, or a directory holding one; any tests' write in their copy is Inexact too.
  Frames of the grader, unittest and the import system are exempt. Inexact rather than "fail on access" because
  a candidate that writes and reads back its own files, with tests that never look, is correct (fs_roundtrip_ok).
- The plain run's tests read `terrarium_grading.workspace` from the same sealed `src` (it's passed as --source), so
  reads through it never differ; only paths relative to the tests' cwd do (plain: the candidate's live copy). The
  isolated tests now run in `cwd`, hard links to `src`, and only that copy is checked. Before this, the VM test of
  the source-rewrite cheat got Inexact instead of its FAIL (same "disagree" verdict, wrong reason).
- Per-call cost: fix-roman (8,000 calls) took 0.90 s locally vs 0.55 s before the session (VM: 2187 vs 1785 ms).
  Per message: getcwd() on the candidate side (10 us on macOS), the random module's getstate() on both sides (a
  625-tuple, 4 us each, pre-existing), and the empty linked dicts of function stand-ins. Now getcwd() runs only after
  an audited chdir, rename, rmdir or rmtree (every message once a process was started or native code called); the
  random state is compared through the generator's C state read in place (checked against getstate() first, else
  getstate() as before) and getstate() runs only when that changed; empty dicts skip the item compare. fix-roman
  0.56 s.

- getsizeof from candidate code: a copy that crossed has the original's size when the size follows from the value
  (tuple, int, bool, float, complex, bytes, None, ASCII str). Lists, dicts and sets depend on how they grew, a
  non-ASCII str on whether its UTF-8 form was cached: those stay Inexact (sizeof_list).
- Caught grading errors: `GraderError.__init__` counts every one made in the process (grade_rpc.RAISED). Tests' side:
  the runner writes the last one, and grade.py turns an all-passed isolated run that made one into an error.
  Candidate side: a request whose handling made one and then returned normally, or raised something else,
  poisons the run (the candidate's code caught it). Grader-internal catches all re-raise, poison, or turn into an
  error the tests see, so nothing passing before changes (all suites below).
- Linked lists: changed() compared every list through ctypes (memcmp on the item array): about 0.4 us fixed, 0.6 to
  1 us with this session's audit hooks, since id(), from_address and the foreign call each raise an audit event.
  Lists of up to 64 elements are now compared in Python (75 to 130 ns); longer ones as before.

## Hurdles
- `hasattr(FunctionType, "__annotate__")` is False on 3.14+ (class-level lookup raises): annotations were read
  through `__annotations__`, calling the stand-in's `__annotate__` RPC from inside message building; recursion only
  showed in the threads probe. Fixed with a version check.
- `_PLAIN` already existed in grade_rpc; a second definition was silently overwritten later in the module.
- tz_ok used `EST5EDT`, which musl (Alpine VM) reports as ('EDT', 'EDT'): plain Python failed it in the VM. Now a
  DST-free zone.
- dcg blocks heredocs with destructive-looking text and `rm -r`: edits go through script files in /tmp/terr-scratch/gen.

## Verification (final: 6d526bf)
- qa/review5-cases (run.py, plain unittest beside the isolated verdict): 88 of 88 as expected on Python 3.12.15 and
  3.15.0. On the pre-session grader, 5 of the first 34 were.
- qa/review4-probes: 39 of 39 on both. qa/review3-probes: 16 of 17 match plain on both; perf_held6k is a grader
  error at the 30 s probe timeout (sync cap), the same on the pre-session grader.
- Grading node tests (grade-probes, grade-local, grade-rpc): 39 of 39. Full backend `node --test`: 206 tests, 204
  pass, 2 skipped (VM-gated), 0 fail. tsc --noEmit: clean.
- evals/scripts/verify.ts: all passed (41 cases: every reference passes, starter and os._exit(0) cheat fail).
- verify_datasets: HumanEval 164/164, MBPP 427/427 (Python 3.12 and 3.15), GSM8K 1319 and MMLU 2524 items, 0
  failures. Before 6d526bf, MBPP 596's reference failed.
- VM, whole vm.test.ts: 22/22 three times (31edaa1 via guest/verify.sh with policy 16/16; 6d526bf via
  guest/verify.sh with policy 16/16; 6d526bf alone).
- randcheck (RandomState reader against getstate): ok on 3.12.15 and 3.15.0.

## Timings
VM, coding references, ms. Baseline = before the session. The 31edaa1 run was at normal load; both 6d526bf runs
had another session's Xcode build and iOS simulator on the Mac (load average about 55 to 67), so they read high
and aren't comparable to the baseline. No timeouts were tuned around them.

| case | baseline | 31edaa1 | 6d526bf run 1 (load ~60) | 6d526bf run 2 (load ~60-67) |
|---|---|---|---|---|
| fix-csv-export | 1161 | 1138 | 1150 | 1208 |
| fix-inventory | 1142 | 1208 | 1117 | 1218 |
| fix-pagination | 1223 | 1081 | 1190 | 1197 |
| fix-roman | 1785 | 1898 | 1868 | 2148 |
| implement-lru | 1250 | 1234 | 1127 | 1337 |
| implement-slugify | 1197 | 1144 | 1167 | 1188 |
| parse-duration | 1272 | 1127 | 1123 | 1312 |
| refactor-report | 1205 | 1132 | 1092 | 1285 |
| gradeMs (fix-pagination via gradeTests) | 1391 | 1359 | 1612 | 1997 |

VM perf probes, ms (31edaa1 / 6d526bf run 1 / run 2): perf_records 1941 / 2182 / 15852, perf_records6k 2779 / 2994 /
13817, perf_held6k 6525 / 7105 / 13740, perf_bsearch 3762 / 4055 / 4065, perf_returns 2283 / 2765 / 2933. Run 2's
perf numbers swing 2x to 7x with the load; pre-session (TODO_13): 2041 / 3250 / 7081 / 4429 / 2757.

Local (Mac, Python 3.12, isolated wallSeconds, 3 runs; pre-session grader vs 6d526bf, same sitting):
bench15k (15,000 calls in 3 tests) 1.86-2.10 vs 2.06-2.14; held8k 0.61-0.66 vs 0.59-0.61; access8k (`m.g(i)` looked
up per call) 1.21-1.26 vs 1.39-1.47; fix-roman 0.66-0.67 vs 0.59-0.66. perf_held6k containers synced in its 7 s
cap: 3,846-3,874 before the session, 3,415-3,435 at 31edaa1, 4,779-4,785 at 6d526bf.

## Commits
085dfe2, 338f944, b9bcd0b, 2dd3a2c, 9b90cea, 3df1d9a, 4d62933, a09421b, 31edaa1, 6d526bf.

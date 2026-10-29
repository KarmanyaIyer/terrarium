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
- [x] Per-call cost back to the pre-session level (it had risen about 60%)
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

## Hurdles
- `hasattr(FunctionType, "__annotate__")` is False on 3.14+ (class-level lookup raises): annotations were read
  through `__annotations__`, calling the stand-in's `__annotate__` RPC from inside message building; recursion only
  showed in the threads probe. Fixed with a version check.
- `_PLAIN` already existed in grade_rpc; a second definition was silently overwritten later in the module.
- tz_ok used `EST5EDT`, which musl (Alpine VM) reports as ('EDT', 'EDT'): plain Python failed it in the VM. Now a
  DST-free zone.
- dcg blocks heredocs with destructive-looking text and `rm -r`: edits go through script files in /tmp/terr-scratch/gen.

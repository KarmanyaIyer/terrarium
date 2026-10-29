# Review 5: bounded final review (independent, Opus 5.5 on the Legion, 2026-10-29, 638a747..9f28698)

Scope limited to: (a) a wrong or cheating solution getting a pass, (b) breakage in normal use, (c) escape or false or
incomplete display, (d) crashes, hangs, stuck states, data loss. Grok 4.7 sub-reviewer; Codex refused twice. Every
grading item reproduced on Python 3.12 (the guest's version) with `grade.py --local`.

Backend and UI: nothing in scope (b)-(d) remains (retry route, remedies, tokens, VM slots, reaper, net log, deleted-env
blocking all checked).

Status: all fixed (2026-10-29). Record: TODO_15.md.

## Findings (all need a forged plain run except the correct-code half of 2; no shipped suite is exposed)
1. **Medium-High: candidate-side state changes never reach the tests:** `os.environ`, cwd, `sys.argv`, replaced
   `sys.stdout/stderr/stdin`, replaced `builtins.print/input`, `sys.path`. `Server._report` (`grade_rpc.py:2780`) sends
   only output, stdin use, random state, recursion limit, decimal, warnings; `Client._apply_state` (`:1995`) has no
   case for the rest. README claims they're mirrored (only tests -> candidate is). Repro: `os.environ["LEAK"]="1"` in
   the candidate, test asserts it isn't set.
2. **Medium: `@contextmanager` with an exception in the `with` body.** `_forward("__exit__")` (`:1265`) sends the test's
   traceback as a TestObject handle; contextlib sets `exc.__traceback__` -> `TypeError` (an ordinary Exception, breaking
   "grader errors are never Exception"). Correct `working_directory` + `assertRaises(KeyError)` -> disagreement;
   wrong `reraise_as(TypeError)` passes when forged. Fix: send None as the traceback; any failure from a test handle
   used where a real built-in is needed -> GraderError.
3. **Low-Medium: every documented gap tried yields a forged pass:** logging handler added by the test (`addHandler`
   not refused; `assertLogs` is, `grade_runner.py:174`); `__slots__` without `__weakref__`; `type(m.f) is
   types.FunctionType`; traceback frame names; `sys.path` assignment; (read only) `id()` of re-fetched cached
   instance, raw stdlib assignments, locale, tzset, umask.
4. **Low: `sys.getrefcount` / `gc.get_referrers` see only the stand-in.**
5. **Low: identity of by-value objects lost across messages** (Encoder memo per message, `:547-629`, new Encoder at
   `:2049`, `:2823`): `lru_cache`d tuple, `assertIsNot(m.pair(3), m.pair(3))`.
6. Nit (fails safe): Python 3.13+ namedtuples gain `__replace__`, missing from `_plain_ntuple`'s allowed set
   (`:2212`); 2 backend tests fail on 3.14.

## REVIEW_4 verdicts
Fixed: 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, nits. Partial: 1 (findings 1, 2, 4, 5 and the gaps), 6 (finding 2).

## Tests (Linux)
Backend 199 on 3.14 without sandbox-exec: 167 pass, 24 fail (21 sandbox-exec, 1 mid-run Retry needs a sim env, 2 the
3.13+ nit), 8 skipped; with a sandbox-exec stub on 3.12: 192 pass, 3 fail (macOS profile tests), 4 skipped. Grading
23/23 on 3.12. UI 13/13, tsc 0/0, vite OK, verify.ts 41/41, datasets 0 failures.

## Decision (2026-10-29)
Fix 1, 2, 6 and close 3-5 by strictness where cheap. An audit hook in the plain runner was planned too, but the fix
agent's design work on it was stopped by the model's safety filter; it was dropped rather than reworded, since the
guarantee below doesn't depend on it. After this, no more open-ended review rounds.

## Fixes
Guarantee: the isolated run's verdict alone never passes where plain unittest fails; anything it can't reproduce is
`Inexact` (a grader error). The plain run must still agree. A forged plain run can only turn a fail into a
disagreement, unless a fidelity gap not yet found exists. Shipped suites (coding, HumanEval, MBPP) are not exposed.
- 1 **Fixed** (085dfe2, 338f944, 4d62933, a09421b, 31edaa1): environment, cwd, argv, streams, print/input, umask,
  locale, time zone, `random` and C-level settings mirrored both ways; tests' `sys.path` reaches the candidate.
  Inexact: candidate `sys.path` changes, unmirrorable settings (signals, rlimits), tests reading workspace files the
  candidate changed (tests get their own sealed copy). 32 cases.
- 2 **Fixed** (085dfe2): forwarded `__exit__` gets a real traceback; frame names and test handles used as built-in
  data are Inexact. 6 cases.
- 3 **Fixed** (2dd3a2c, 9b90cea, 3df1d9a): candidate functions, generators and modules are real objects on the tests'
  side; slots without `__weakref__`, logger levels, tests' stdlib assignments, `id()`, type hints, reload. Inexact:
  candidate-added logging handlers, `vars(m)`, frame names, candidate raw stdlib assignments, tests editing
  `sys.modules` or class descriptors. 33 cases.
- 4 **Fixed** (b9bcd0b, 6d526bf): refcounts, referrers, weakref and process-wide counts on shared objects are Inexact;
  `getsizeof` of value-sized copies allowed (MBPP 596).
- 5 **Fixed** (338f944, 3df1d9a): by-value objects keep identity across messages; identity checks on unkeyed impure
  tuples are Inexact. 7 cases.
- 6 **Fixed** (085dfe2): namedtuple `__replace__`.
- Found in verification, **Fixed** (6d526bf): a grading error caught by a bare `except:` (tests or candidate) let the
  run pass; now any run that caught one can't pass.

Known costs and gaps (guest/README.md): `m.f(x)` looked up per call costs ~25 us extra (8,000-call loop ~15% slower);
`perf_held6k` still ends at the sync cap (4,780 containers now vs ~3,860); symlinks removed in the sealed copy; a
module the candidate writes during the run can't be imported by the tests.

## Tests after fixes (macOS, 6d526bf)
Review 5 cases 88/88 (Python 3.12 and 3.15); review 4 probes 39/39; review 3 probes 16/17 match plain (perf_held6k as
before); grading node tests 39/39; backend 206: 204 pass, 2 skipped (gated); verify.ts 41/41; HumanEval 164/164, MBPP
427/427, GSM8K/MMLU 0 failures; vm.test.ts 22/22 (3 runs), policy 16/16; UI 13/13; tsc clean.

# Review 5: bounded final review (independent, Opus 5.5 on the Legion, 2026-10-29, 638a747..9f28698)

Scope limited to: (a) a wrong or cheating solution getting a pass, (b) breakage in normal use, (c) escape or false or
incomplete display, (d) crashes, hangs, stuck states, data loss. Grok 4.7 sub-reviewer; Codex refused twice. Every
grading item reproduced on Python 3.12 (the guest's version) with `grade.py --local`.

Backend and UI: nothing in scope (b)-(d) remains (retry route, remedies, tokens, VM slots, reaper, net log, deleted-env
blocking all checked).

Status: open.

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
Fix 1, 2, 6 and close 3-5 by strictness where cheap. Also harden the plain run itself so forging it stops being an
8-line patch: an audit hook installed by the plain runner before candidate code loads (sys.addaudithook can't be
removed from Python) that refuses or flags the usual tampering routes. After that, stop open-ended review rounds;
document the guarantee and the residual threat model.

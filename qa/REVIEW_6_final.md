# Review 6: final bounded review of 9f28698..8c2d21f (Opus 5.5 on the Legion, 2026-10-29)

Scope: (a) isolated pass where plain `python3 -m unittest` fails, (b) regressions in normal use. Hunters: 3 Grok 4.7
and Codex GPT-6.1-Sol; I re-ran every finding with `grade.py --local` on Python 3.12.15 and 3.14.4 (identical results).

Status: not clean. 4 regressions in normal use (Medium) and 42 lenient cases; 11 of those are new in this diff, the
other 31 also pass on 9f28698. No shipped suite is affected, and a lenient case needs a forged plain run to become a
pass. Cases: qa/review6-cases/<name>/ (58); cases.json lists plain and isolated verdicts (3.12, 9f28698, 3.14).

## Regressions (correct code, plain passes; 9f28698 passed every one of these)
1. **Medium: `inspect.getsource(m.f)` is Inexact.** grade_runner.py:74 (`module_namespace` refuses inspect/linecache
   reading `m.__dict__`). Case getsource_ok. README says source checks work, and "must not use X" source tests are a
   common eval idiom. Fix: return the stand-in module's own dict to inspect and linecache callers.
2. **Medium: `asyncio.run(m.f(1))` on an `async def` is Inexact.** grade_rpc.py:2570: the stand-in awaits a coroutine
   proxy, and `__await__` is unsupported. Case async_fn. Fix: the candidate side drives the coroutine to its result.
3. **Medium: a generator the candidate already started (priming `@coroutine` decorator) breaks.** grade_rpc.py:2616:
   `_gen_wrap` always starts unstarted, so `send(10)` raises TypeError and `throw()` never reaches the candidate.
   gen_primed_ok, gen_primed_throw. Lenient twin gen_primed_lenient (`assertRaises(TypeError)` around send).
   Fix: prime the stand-in with a yield that skips the candidate and forward every send/throw, the first one too.
4. **Medium: every message scans every function stand-in.** grade_rpc.py:3367 `_fn_state`, :5028 `fn_sent`, so a run
   costs O(N^2). 600 held closures each called once: 0.06 s isolated at 9f28698, 1.1-1.3 s now. 2,000: 0.2 s -> 11 s
   (about 6,000 would hit a timeout). function_many, function_many_2000. Fix: one C-level compare per side
   (`map` over a flat attrgetter tuple) or re-measure by refcount like links.
- Low, also new: bound_method_identity_ok (new MethodType per decode, :3140); function_dict_replace_ok (`f.__dict__`
  replacement not mirrored, :2596); fn_self_attribute (`f.again = f`: "function without a description", :3183);
  sizeof_named (namedtuple getsizeof poisons, :1003); id_assertisnot_two_floats (local floats Inexact, :4004).

## Lenient: isolated pass, plain fail
5. **Medium: identity is guarded only for positional `assertIs`/`assertIsNot`** (:3944, :4004; Encoder :1186-1282).
   Raw `is`, `id()`, `operator.is_not` and `expr1=` keywords bypass it for impure tuples, bulk numbers and NaNs that a
   sync re-sends. New: an impure tuple met twice in one message now arrives as two objects (9f28698 kept one).
   ident_is_lenient, id_fs_impure (new), id_list_big_false, id_dict_same_false, id_nan_sticky_false,
   identity_assert_keyword, bound_method_identity (new). Fix: alias impure tuples per message; re-send held numbers
   by key; guard `id()`/`operator.is_`; route non-constant `is` in the tests through the check (AST pass at load).
6. **Medium: a process the tests start reads their sealed copy.** grade_rpc.py:3896 (tests-side `_FS_ANY` only sets
   `cwd_any`). fs_subprocess_tests: candidate deletes data.txt, the tests' `cat data.txt` still reads it. Fix: after
   any candidate workspace change, a tests-side process start or ctypes call is Inexact.
7. **Medium: tests' "quiet" log handlers aren't mirrored.** grade_rpc.py:3865. Tests' `basicConfig()`/NullHandler
   stop logging's last-resort handler in one process; the candidate's process has none, so its warning reaches the
   tests' redirected stderr. log_lastresort (lenient), log_lastresort_ok (correct code fails). Fix: give the
   candidate's same-name logger a NullHandler stand-in.
8. **Low: workspace looks and changes the fs check misses.** Pre-opened file object, `os.fstat`, `mmap`
   (preopened_read, fstat_size, mmap_read); `DirEntry.stat()` (fs_direntry); sqlite `file:` URIs (sqlite_uri,
   :987/:4384); `os.open(dir_fd=)` (dir_fd_open, the audit event has no dir_fd); late thread writes (fs_thread_after,
   :4407). Fix: resolve URIs, wrap os.open, poison `_fs_note` at depth 0, check tests' open fds when "fs" arrives.
9. **Low: process state outside the mirrors.** std-library state in instances and dict contents (std_instance_state:
   `calendar.setfirstweekday`, `mimetypes.add_type`; logging_level_name; log_direct_handler; log_filter_lenient;
   stdlib_clear, dict CLEARED ignored :2153; stdlib_module_attr, `os.path = None` skipped); tz_lenient (`tz_now`
   5-tuple :732, so the README's tz claim fails for zones sharing it); decimal_setctx_lenient (:563 mutates rather
   than `setcontext`); putenv/unsetenv (unsetenv new); stdin_seek/write_lenient (:3285); stack_bypass_lenient
   (`_thread.stack_size`, :797); path_import_lenient; thread_env_lenient (`_status` :5263). Fix: a per-test
   fingerprint of std modules' mutable globals in `_status`, plus the narrow fixes.
10. **Low, all new: stand-ins expose grader state.** tb_chain, traceback_line (`synthetic_traceback` :523 is one node
   with grader lines; 9f28698 was Inexact); gi_yieldfrom, generator_external_close (`_gen_wrap` state);
   fn_referents, fn_weakrefcount (`_crossed` :3790 omits stand-ins). Fix: treat `tb_next`/`tb_lineno`/
   `gi_yieldfrom`/`gi_suspended` like `gi_frame`; add `_standin_rid` to `_crossed`.
11. **Low: misc.** ref_int_low (getrefcount of an unkeyed copy is local); module_type_multiline (grade_runner.py:112
   regex is per line); warn_import_silent (grade_runner.py:296 lacks `warnings="default"`, which `python -m unittest`
   sets; affects both runs). Strict, pre-existing: skip_only (a skip counts as a failure in both runs, :295).
12. **Low: repo asset.** qa/review5-cases/cwd_ok/data/x.txt was never committed (`.gitignore` `data/`), so cwd_ok and
   node test "review 5, #1" fail on a fresh checkout. Fix: `git add -f` it.

## Review 5 items
- 1 Candidate state reaches the tests: **partial.** Every listed route works; gaps in 7 and 9.
- 2 `__exit__` traceback: **partial.** The TypeError is gone; the synthetic traceback is lenient (10).
- 3 Documented gaps via stand-ins: **partial.** Ordinary use works; regressions 1-4, items 10-11.
- 4 refcount/gc Inexact: **partial.** Stand-ins and unkeyed copies escape (10, 11).
- 5 Identity across messages: **partial.** Keyed values hold (lru_cache tuple, str, bytes); see 5.
- 6 namedtuple `__replace__`: **confirmed** (3.14).
- Bare-except fix (6d526bf): **confirmed.** 14 routes never pass: suppress, `__exit__` True, ExitStack, `except*`,
  generator finally/close, threads, excepthook, `__del__`, callback chain, later re-raise, subTest, addCleanup.

## Tests (Linux, 8c2d21f)
- Review 5 cases 87/88 on 3.12.15 and 3.14.4 (cwd_ok, item 12; passes with its file). Review 4 probes 39/39. Review 3
  probes 16/17 match plain (perf_held6k at the sync cap, as before).
- Backend `node --test`, 3.12, sandbox-exec stub: 206 tests, 196 pass, 4 fail (3 macOS profile tests, review 5 #1),
  6 skipped. The stub needs root at /usr/bin, so this ran in a copy whose `SANDBOX_EXEC` points at /tmp.
- verify.ts 41/41; HumanEval 164/164; MBPP 427/427 (3.12).
- Speed vs 9f28698 (isolated test seconds, best of 3): references and perf probes 1.0-1.6x (fix-roman 0.60 -> 0.86,
  perf_records 0.74 -> 1.16, perf_returns 0.97 -> 1.42). Only regression 4 exceeds 2x.

## Fixes (TODO_16, 2026-10-29)
- 1 `inspect.getsource(m.f)`: **Fixed** (4cbac17). getsource_ok passes.
- 2 awaiting a candidate coroutine: **Fixed** (4cbac17). Stepped in the candidate for the tests' event loop; the
  candidate's coroutine using the loop itself (futures, timers, tasks) is Inexact.
- 3 primed generators: **Fixed** (c30d646). gen_primed_ok and gen_primed_throw pass; gen_primed_lenient fails.
- 4 per-message cost of function stand-ins: **Fixed** (c30d646). Only functions candidate code may reach (by
  refcount) are compared; function dicts aren't links. Mac, load 12-13: function_many 0.35 s (9f28698 0.24 s),
  function_many_2000 0.75 s (0.46 s). Functions candidate code holds still cost about 1.3 us per message per side.
- Low: bound_method_identity_ok: **Fixed** (a02ccbd). function_dict_replace_ok: **Fixed** (c30d646).
  fn_self_attribute: **Fixed** (c30d646). sizeof_named: **Fixed** (a02ccbd). id_assertisnot_two_floats: **Fixed**
  (a02ccbd).
- 5 identity: impure tuple met twice in one message is one object (id_fs_impure; bound_method_identity now
  fails): **Fixed** (e3bf3cc, a02ccbd). Keyword `assertIs(expr1=, expr2=)`: **Fixed** (e3bf3cc). Raw `is`, `id()`,
  `operator.is_` on values that arrive anew each message (ident_is_lenient's other three tests, id_list_big_false,
  id_dict_same_false, id_nan_sticky_false): **Documented**.
- 6 a process the tests start after candidate file changes (fs_subprocess_tests): **Fixed** (e3bf3cc). Inexact
  after a known candidate change only, so fs_process_ok (candidate's own `echo`) still passes.
- 7 tests' quiet log handlers (log_lastresort_ok passes, log_lastresort fails): **Fixed** (052af63).
- 8 workspace looks and changes the fs check misses: **Documented**.
- 9 process state outside the mirrors: stack_bypass_lenient **Fixed** (ae00233); the rest **Documented**
  (tz_lenient fails both runs on macOS; in the Alpine guest without tzdata plain unittest passes it).
- 10 stand-ins expose grader state: tb_chain, traceback_line, generator_external_close **Fixed** (c30d646, now exact
  fails); gi_yieldfrom, fn_referents, fn_weakrefcount **Fixed** (c30d646, Inexact).
- 11 misc: ref_int_low **Fixed** (e3bf3cc, Inexact); module_type_multiline **Fixed** (e3bf3cc, Inexact);
  warn_import_silent **Fixed** (ef49929, both runs); skip_only **Documented** (intentional).
- 12 cwd_ok asset: **Fixed** (58c1c75, before this round).
- Tests: review 6 cases in grade-probes.test.ts and vm.test.ts (a5285b6, c13f748); docs (c5f5b99).

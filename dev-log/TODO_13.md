# TODO 13: sound isolated grading (review 4 findings 1, 4, 5, 6, 7, 12, nit)

Date: 2026-10-29. Session: ae7708eb-2b88-4ef3-8f9d-ac3bf406fdd7.

Principle (decided, qa/REVIEW_4_delta.md): the isolated run may never report a pass that the same tests would not
give the same code in one process. Exact where cheap, else GraderError.

## List
- [x] Baseline probes (qa/review4-probes, run.py: honest + forged plain + plain unittest)
- [x] grade_rpc.py rewrite: links both ways, proxies (classes, hybrids, exceptions), strict equality, I/O mirroring
- [x] grade_runner.py / grade.py: module setattr, shared hash seed, per-test status, foreign mock patches
- [x] Tests (rpc, local, probes, VM), verify_datasets timeout
- [x] Docs (guest/README.md, DESIGN.md)
- [x] Process state: recursion depth/limit, decimal context, warnings; assertLogs strict
- [x] Verification + timings, adversarial pass, commits

## Baseline (old grader, grade.py --local, Python 3.12, Mac)
qa/review4-probes/run.py: 3 of 30 as expected. Every LENIENT probe (17) passes with a forged plain run;
ne_lie passes outright; every CORRECT probe (10) is a disagreement (hash_seed KeyError, ctx no context manager,
mock_patch 2 != 10, bigint candidate gone for both tests, exc_attrs no .code, nested_tuples 172 MB message after
22 s, copy_hy copies the proxy, type_is Ref, threads 0 != 800, stdout_capture empty). perf_bsearch (1M list x 300
calls) 6.2 s isolated at --timeout 30 (sync cap 6.75 s); perf_returns 0.25 s.
Scan primitives, 1M-element list: identity scan 7.0 ms, list == 0.43 ms, list copy 1.6 ms, marshal 11 ms.

## Progress notes
- New grader: qa/review4-probes 32 of 32 as expected (added nest_reheld CORRECT, nest_stale LENIENT); review 3
  probes all match plain except perf_held6k (12,000 links both sides hold: sync cap, visible error, as before).
- Bugs hit while building and fixed:
  - Proxy __del__ passed a refcount int as the probe list: dead weakrefs, "unknown object" protocol errors.
  - Identity, not ==, when checking proxy liveness (== would call into the candidate).
  - Exception chains (cause is context) need decoder alias registration for proxies.
  - Runner segfault at GC: CPython 3.12 gives a slotted class whose MRO holds real Python classes a dict offset of
    -1 without the managed-dict flag. Proxy classes have no __slots__ now.
- Perf regression after the rewrite (perf_records 0.21 s -> 7.5 s): links nested in other links (each record's
  tags list) counted as held through their parent's live storage, so 3,000 lists were re-checked every message.
  Holding is now: something besides the bookkeeping refers to the link, or a held link's storage holds it; a held
  link's snapshot kids are held with it (found by a probe: a link let go and then reached again through a returned
  parent must be re-held, or the test's edits to it are never synced). Sweeps: new links every message, links both
  sides hold ~64/message, all held ~8/message (memory only).
- Status ping between tests checked every link for changes: false "thread" errors for links only the candidate
  reaches (legitimately unsynced). Now it checks only links the tests hold.
- Per-message cost: env compared through os.environ._data (100 ns vs a dict(os.environ) decode), list comparison
  with memcmp through PyDLL (no 8 MB copy per check of a 1M list).
- Timings (Mac, --local, isolated wall): perf_bsearch 0.77 s (was 6.2 s at the sync cap), perf_returns 1.0 s (was
  0.25 s: 2 round trips per row, ~60 us each, vs ~25 us before), perf_records 0.6 s (0.21), perf_records6k 1.15 s
  (0.47), perf_keep 0.21 s, perf_big 0.2 s.
- More bugs found by probes and fixed: `m.Color.RED` (an enum member reached through a class) fell through
  proxy_rid and came back a test object; a fake `builtins.ValueError` class name broke the protocol (built-in
  exceptions are now an identity set); keyword arguments to candidate callables were dropped by the forwarded
  __call__ (a regression I introduced; caught by the keyword case in the #6 rpc test).
- Process state (review 4 brief: "anything else that makes isolated differ from one process"):
  - Stack depth: each request carries the requester's non-grader frame count; the executor pads the stack so a
    recursion runs out where one process would (exact for direct calls, ~5 frames stricter per callback hop).
  - Recursion limit, decimal context (prec, rounding, flags, traps) and warnings filters mirrored both ways; the
    tests' showwarning hooks reach the candidate (assertWarns works). Candidate replacing showwarning: error.
  - assertLogs/assertNoLogs raise Inexact (logging is per process; a forged plain run made logs_none pass).
  - New probes: rec_depth, dec_ctx, logs_none, warn_quiet (LENIENT), warn_ok (CORRECT). Old grader: all of the
    lenient ones pass with a forged plain run.
- Adversarial pass (every place the test side answers without asking the candidate):
  - Weak references: a test's `weakref.ref(obj)` died with the test's proxy even while the candidate still held the
    object, so a "registry must not keep items alive" test passed for a strong-dict registry (old grader: forged
    plain -> pass). Now: proxies that die with test weak references (including the registry's own shared
    callback-less weakref, counted by refcount) are released in death order, and the candidate checks each one as
    it is released; still alive (or not weakly referenceable) -> Inexact at the next reply. Probes weak_cache
    (LENIENT) and weak_ok (CORRECT). Remaining: an LRU-eviction test that drops its proxy while the candidate holds
    the object is a grader error, not a pass (documented).
  - Fixed along the way: the candidate's serve loop kept the previous request's arguments alive until the next
    message (objects outlived one process's lifetime).
  - Checked, left as is: comparisons (data agreement rule), hashes (shared seed; "local" only when the data type's
    hash is inherited), exception __traceback__/__cause__/__context__ (local; tracebacks hold test-side frames:
    known gap, documented), __class__ (real std class or stand-in, Inexact for unmirrorable bases),
    __repr__/__str__/__dir__/__sizeof__ always forwarded, __format__ forwarded when overridden.
  - Documented known gaps (wrong answers, not errors): type() of candidate functions/modules/generators, logging
    handlers, std monkeypatching without mock.patch, locale/tzset, tracebacks, weakref of slotted classes.

## Verification
- Pre-weakref build (commit 419f63d), all on the Mac:
  - grade-rpc/local/probes tests 32/32; review-4 probes 37/37 as expected; review-3 probes all match plain except
    perf_held6k (visible disagreement, sync cap, 7.5 s).
  - evals/scripts/verify.ts all passed; verify_datasets gsm8k 1319, mmlu 2524, humaneval 164, mbpp 427, 0 failures.
  - backend tsc clean; full backend node --test 199 tests: 197 pass, 0 fail, 2 skipped (VM-gated).
  - guest/verify.sh: policy 16/16, vm.test.ts (TERRARIUM_VM_TESTS=1, whole file) 21/21.
- Before/after (old grader = HEAD before this work, new tests added): VM 20/21 before (review-4 test fails at
  bigint), 21/21 after. New rpc tests fail on the old grade_rpc.py copy and pass on the new one.
- VM grading time per coding reference (ms), before -> after:
  fix-csv-export 1367 -> 1182, fix-inventory 1256 -> 1281, fix-pagination 1285 -> 1261, fix-roman 1398 -> 2088
  (one-off; 1946 and 1340-1440 in other runs), implement-lru 1324 -> 1293, implement-slugify 1543 -> 1348,
  parse-duration 1266 -> 1316, refactor-report 1269 -> 1209. Most of each is the VM round trip and two Python
  startups; per call cost ~70 us vs ~25 us before.
  Review-3 perf in the VM: perf_records 1540 -> 2041, perf_records6k 1959 -> 3250, perf_held6k 6609 -> 7081.
  Review-4 perf: perf_bsearch 4429 (sync cap before: fail at timeout 60 ~ 6.2 s local), perf_returns 2757.
- Final build (commit 925ac73, weak references), rerun of everything:
  - grade-rpc/local/probes tests 32/32; review-4 probes 39/39 as expected; review-3 probes match plain except
    perf_held6k (7.5 s, visible disagreement).
  - verify.ts all passed; datasets gsm8k 1319, mmlu 2524, humaneval 164, mbpp 427, 0 failures; tsc clean;
    backend 199: 197 pass, 0 fail, 2 skipped; guest/verify.sh policy 16/16, vm.test.ts 21/21.
  - VM coding references (ms): fix-csv-export 1639, fix-inventory 1281, fix-pagination 1484, fix-roman 2962,
    implement-lru 1561, implement-slugify 1394, parse-duration 1338, refactor-report 1126; gradeMs 1615. The host
    was loaded during this run (trivial review-4 probes at 3 s vs 1.4 s); locally the final grader is as fast as
    419f63d (perf_returns 1.2 s vs 1.9-4.1 s, perf_bsearch 1.0 s vs 1.0-1.8 s, same conditions).

## Commits
- af15378 verify_datasets: kill a grade after 2x the case timeout
- 419f63d Grading: sound isolated run (review 4)
- 925ac73 Grading: weak references to candidate objects die as in one process, else a grader error

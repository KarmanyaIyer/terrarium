# Review 3: delta review (independent, Opus 5.5 on the Legion, 2026-10-29, f47fc4a..2545a56)

Scope: the review 2 fixes and the TODO_9 follow-up. Codex reviewed reaper/locks, Grok the smaller items; the reviewer
reran or read every claim. Probes: Legion `/tmp/terr-final/probe/` (`python3 run.py <case>`, each case under both
graders).

Status: all 9 fixed (2026-10-29). Records: TODO_10.md (grading), TODO_11.md (backend/UI), TODO_12.md (context
accounting and leftovers the fix agents found).

## Findings
1. **High, regression: candidate subclasses of built-in types skip their own `__contains__`/`__eq__`/`__hash__`/
   `__getitem__`** (`grade_rpc.py:493-500,535-547,651-674`; since 25f6cd3 the test side answers from data alone).
   `LRUCache(OrderedDict)` whose `__contains__` counts as a use (the bug `test_contains_is_not_a_use` targets): new
   grader 6/6, plain unittest 4/6, old grader 1/6. Also: namedtuple data never re-read (in-place mutation bug passes);
   a correct case-insensitive dict subclass fails `assertIn("KEY", d)`; overridden `__hash__`/`__getitem__` ignored.
2. **Medium: review 2 #2 bypassed with a symlink.** `grade.py:144-147` `seal()` skips symlinks, `:157` `cp -a` keeps
   them; live /workspace stays agent-writable during grading. `report.py` -> `/workspace/.real/report_src.py` +
   rewrite on import: 3/3 (regular file: 2/3).
3. **Medium, new: grading time quadratic in containers the candidate keeps** (`grade_rpc.py:962-978` re-encodes every
   linked container after every message). Correct `Inventory.add(record)` x 6000: deadline at 115 s of 120 (old
   grader 0.42 s, plain 2 ms); 3000 fail at `--timeout 30`.
4. **Medium, older: shared containers still don't behave as in one process** (`grade_rpc.py:709-738` sync is
   candidate -> test only; `:160-192` no aliasing in by-value encodes). Warehouse keeping the caller's dict passes a
   test expecting isolation (plain fails); a correct sharing object fails and its sync overwrites the test's key;
   `[[0]*3]*2` shared-rows bug passes under old and new grader (plain fails).
5. **Low/Medium: new eval env visible for seconds before the eval owns it** (`runner.ts:299` fork/seed/session,
   ownership at `:319`, exec check `manager.ts:813`). A user shell command (root) started in that window survives into
   grading; `killAgentProcesses` doesn't kill root. User-only; the agent can't reach the API.
6. **Low, older: 2-VM cap briefly exceeded.** `vm/driver.ts:452-454` marks stopped before guest sync (up to 10 s) and
   close; plain stop doesn't hold the boot lock. `manager.ts:267-275`: two first-touch requests open two runtimes, the
   booted one untracked.
7. **Low: reaper.** `reaper.ts:26,80` pin LC_ALL but not TZ (`lstart` follows the Mac's timezone; after a TZ change
   the guard and reaper refuse to kill: safe direction). Arming window between VM spawn and guard/record: killing
   backend + shell then leaves an unrecorded orphan.
8. **Low: UI.** Net log reconnect merge (`store.ts:562-576`) can leave a missing middle band under a "latest N" chip;
   Send/Continue (`Composer.tsx:157`) enabled while another session holds the env (409); `partial` chip
   (`store.ts:346`, `trace.ts:227`) shows for a call opened during prefill with nothing missed.
9. **Low, older (correct solutions fail under both graders):** namedtuple/defaultdict test args arrive as plain types;
   test-callback exceptions reach candidate code as RuntimeError; candidate `SystemExit` isn't a real SystemExit
   (argparse tests fail); `issubclass(m.Child, m.Base)` raises TypeError; every decoded NaN is one object
   (`grade_rpc.py:195`). Silent caps: grade detail shows 12 failures without "N more" (`graders.ts:174`); `grade.py:306`
   keeps the first 50; eval context picker hides 128K (`EvalsView.tsx:614`).

## Review 2 verdicts
Hold: 3, 4, 5, 8, 9, 10, 11, 13, portability. Partial: 1 (findings 3, 4), 2 (finding 2), 6 (finding 6), 7 (finding
8), 12 (finding 1).

## Tests (Linux, Python 3.14)
Backend 152: 127 pass, 19 fail (all sandbox-exec), 6 skipped; every review 2 regression test passes. tsc 0/0, vite
build OK, verify.ts 41/41, datasets 0 failures.

## Decision (2026-10-29)
The RPC grader keeps producing semantic mismatches with plain unittest (5 in review 2, ~10 here). Instead of chasing
each, grade every `tests` check twice: plain unittest in-process (exact semantics) and the isolated RPC grader
(integrity). Pass needs both; a disagreement is a visible grader error showing both results, never a silent pass or
fail. Finding 1 policy (reviewer's recommendation): forward `__contains__`/`__getitem__`/`__len__`/`__iter__` to the
candidate when overridden; for overridden `__eq__`/`__hash__` require local data and the candidate's method to agree.

## Fixes
- Dual grading: **Fixed** (f3ee7f1, 6f00f58): isolated run, then plain unittest as uid 1000 in a copy that was
  root-only until then; pass needs both; a disagreement is a grader error showing both runs. Network goes off before
  tests and command checks grade (70d00d8), since the plain run can read the hidden tests.
- 1 **Fixed** (f3ee7f1): overridden dunders run in the candidate; overridden `__eq__`/`__ne__` count only when they
  agree with local data; tuple subclasses re-read. lru_bug, ci_dict, od_eq, sub_in, stale_tuple, set_obj match plain.
- 2 **Fixed** (f3ee7f1): `seal()` deletes symlinks, never follows them; no copy depends on the live /workspace.
- 3 **Fixed** (f3ee7f1): identity check instead of re-encoding; sync capped, past it a visible grader error.
  perf_records 30 s -> 0.21 s, perf_records6k 115 s -> 0.47 s. Remaining: 12,000 containers held by both sides
  through 6,000 calls hits the cap (visible disagreement, not a pass).
- 4 **Fixed** (f3ee7f1): sync both ways before every message; shared and repeated containers keep identity. grid,
  oneway_pass, oneway_clobber match plain.
- 5 **Fixed** (ec8d455, ef28846): the case owns its env id before the fork inserts it; a failed fork nulls the
  result's env, deletes the half-made env and errors the case with the reason. Test: `envs/eval-ownership.test.ts`.
- 6 **Fixed** (f3ef97d, f5af179): a VM holds its slot until its VMM closes; one runtime per env when opens overlap.
- 7 **Fixed** (12839fa): `TZ=UTC0` on every `lstart` read and in the guard; pid-only record the moment the pid is
  known, reaped only when the command line is a VMM of the recorded kind and it started within [since, seenAt].
- 8 **Fixed** (5ffad8a, 8196137, a2729dd): capped refetch never leaves a hidden gap, and the net log asks for one
  extra row so "latest N" shows only when rows are missing; `partial` only when chunks were missed (chunk index);
  Send/Continue disabled with the reason while another session or an eval holds the env.
- 9 **Fixed** (f3ee7f1, 6f00f58, 8196137): namedtuple/defaultdict keep types, callback exceptions keep their class,
  real SystemExit, issubclass works, separate NaNs; failures past 50 counted, "N more" past 12; picker offers 128K.

Found while fixing (TODO_12): context estimate was ~30% low on digit-heavy text (oMLX rejected 38,909 > 32,768).
**Fixed** (f73ab91, 65939ca): prompts counted with oMLX `/v1/tokenize` on the exact request (26 live calls, counted =
server every time, 0 rejections); oversized tool outputs shortened with a visible marker and "Show original";
over-window prompts refused with numbers and a remedy; `startRun` 409s on eval-owned envs.

## Tests after fixes (macOS)
Backend 180: 178 pass, 2 skipped (gated). Real-VM `vm.test.ts` 19/19 (+ reaper); `guest/verify.sh` policy 16/16,
VM 19/19; `verify.ts` 41/41; HumanEval 164/164, MBPP 427/427 under dual grading; UI logic 7/7; tsc clean, vite
build OK.

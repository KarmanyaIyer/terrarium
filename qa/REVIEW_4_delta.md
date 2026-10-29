# Review 4: delta review (independent, Opus 5.5 on the Legion, 2026-10-29, 2545a56..6141a5e)

Scope: review 3 fixes (dual grading, RPC v2, exact token counts, env ownership, VM slots, reaper, UI). Codex
(grading, framed as Python-semantics comparison), Grok 4.7 (tokens, env/UI); every finding checked by the reviewer.

Status: all fixed (2026-10-29). Records: TODO_13.md (strict isolated grader), TODO_14.md (tokens/UI/VM).

## Findings
1. **High (grade integrity; not a regression): forged plain run + a case where the isolated run is more lenient than
   Python = pass.** Plain run is forgeable by design (`grade.py:357`). Isolated run is lenient in: containers the
   candidate returns cross by value (only nested-in-existing-links get linked, `grade_rpc.py:1262`); overrides outside
   `HY_DUNDERS` (`:687`) answered from base data (arithmetic `:689`, ordering `:800`, `int()`, `format`); exceptions
   rebuilt from `str(e)` (`:476,531`); the test's own built-in subclasses sent as base type (`:271`); stale hybrid
   storage; unsynced defaultdict factory. Repro: `Store.get()` returns its internal list; test does
   `store.get().append(9); assertEqual(store.get(), [])`: honest code = disagree (correct); + 8 lines replacing
   `unittest.TestCase.run` when `test_hidden` is loaded = pass. Shipped suites not exposed (compare returned contents).
   Fix: isolated run strict-only (GraderError for anything it can't reproduce; link returned mutable containers; typed
   exception args) so a forged plain run can only turn a fail into a disagreement.
2. **Medium (UI, a2729dd): "Raise context window" on an output-cap cutoff keeps the same cap** (`Blocks.tsx:483,488,
   544`): with thinking on the cap is already half the window; the window button sends the same `maxOutputTokens`.
   Fix: send `min(cap*2, floor(nextWindow/2))` or let the backend pick the new window's default.
3. **Medium (f73ab91): over-window remedy suggests a window compaction can't use; no retry.** Suggestion = prompt +
   min(maxOutput, 1024) + 320 (`sessions.ts:840`) but compaction limit = window - maxOutput - 256
   (`compaction.ts:82`): 8K, thinking on, 14,059-token paste -> suggests 16,384, compaction limit there 12,032. The
   refused run has no Continue, so the next message turns the paste into an older turn that compaction drops.
   Fix: size with the full output cap (as `explainServerOverflow` does, `:117`); offer Retry after `context_overflow`.
4. **Low-Medium (grading regression): lying `__ne__` passes both runs** (`grade_rpc.py:789`: for `!=` the candidate is
   asked exactly when data are equal). Probe `ne_lie`. Fix: strict mode answers `!=` from data.
5. **Low-Medium (grading regression): forwarded `__hash__` uses the candidate process's hash seed** (`:849` -> `:638`):
   `class Key(str)` with `hash(str(self))`, `{m.Key('abc'): 7}['abc']` -> KeyError, disagreement (old grader passed).
   Fix: use local `hash(data)` when the candidate reports `hash(obj) == hash(base data)`.
6. **Low (older, now visible grader errors): correct code can't pass the isolated run:** `with m.Timer() as t` (no
   `__enter__`/`__exit__` on Ref, `:568`); `mock.patch.object(m, ...)` patches only the test-side proxy module
   (`grade_runner.py:36`); int over 4,300 digits kills the candidate at `json.dumps` (`:99`) and every later test
   errors; exception attributes lost; 22 nested tuples -> 86 MB message; copy/pickle of hybrids fail;
   `type(x) is m.Cls` false.
7. **Low (perf): one large input re-scanned every message** (`:1084`): binary search over 1M list x 300 calls hits
   the sync cap in 7.2 s at `--timeout 30` (~24 ms/call; ~1,200 calls at 120 s). Docs only mention the 12,000-held case.
8. **Low (tokens): tokenizer fallback can exceed the session window** (`stream.ts:182`): estimate never refuses, keeps
   >= 128 reply tokens; oMLX only enforces the loaded context. Tokenizer 404, 4K, 6,000 digits: estimated 2,339, real
   6,059, `max_tokens` 1,024, no warning.
9. **Low (tokens): Stop can't cancel a slow `/v1/tokenize`** (300 s timeout per count, retried each count,
   `tokens.ts:12,53`). Fix: run's abort signal; fall back to estimates for the rest of the run after one failure.
10. **Low (VMs): start can wait ~20 s after a slot is free** (`manager.ts:523` `Promise.all` over closing VMs under the
    boot lock). Fix: `Promise.race`, recount.
11. **Low (UI, older): Send/Continue enabled when the session's env was deleted** (`envuse.ts:8`).
12. **Low (older): hidden tests calling candidate code from several threads garble the RPC** (2 GB message, grader
    error).
Nits: net log at the 5,000 cap always shows "latest 5,000"; a live net row tied to the millisecond with the oldest
fetched row is dropped; reaper pid-only krun record accepts any temp runner config (needs pid reuse within 1 s);
`verify_datasets.ts` kills a grade after 60 s but grading can take 2 x 50 s.

## Verdicts
Hold: R3 #2, #3, #5, #6, #7, #8, #9. Partial: R3 #1 (findings 4, 5, overrides), R3 #4 (returned containers), dual
grading (finding 1), token counting (3, 8, 9).

## Tests (Linux)
Backend 180: 151 pass, 21 fail (all sandbox-exec), 8 skipped; with a sandbox-exec stub 173 pass, 3 fail (macOS
profile tests). UI 7/7, tsc 0/0, vite OK, verify.ts 41/41, datasets 0 failures, review 3 probes 16/16 match plain.

## Fixes
Principle: the isolated run is sound (never a pass Python wouldn't give); anything it can't reproduce exactly is a
grader error, so a forged plain run can only turn a fail into a disagreement.
- 1 **Fixed** (419f63d): returned lists/dicts/sets/bytearrays are the candidate's own objects, linked both ways and
  synced before every message; overridden methods run in the candidate, never on base data; exceptions arrive as real
  types with args, attributes, cause, context; test-side built-in subclasses preserved; defaultdict keeps its factory.
  23 leniency probes x forged plain run: each a disagreement, never a pass (grade-probes, vm.test.ts).
- 4 **Fixed** (419f63d): `!=` and ordering follow `__eq__`'s rule: the candidate's answer counts only when the data
  agree, else `Inexact`. Probe `ne_lie`.
- 5 **Fixed** (419f63d): both processes share one random PYTHONHASHSEED. Probe `hash_seed`.
- 6 **Fixed** (419f63d): context managers, `mock.patch.object(m, ...)`, ints of any size, exception attributes, nested
  tuples (memoized), copy/deepcopy of one object, `type(x) is m.Cls`, kwargs. Still grader errors (never passes,
  listed in guest/README.md): pickling candidate objects, deep-copying structures holding them, test classes
  subclassing candidate classes, some stdlib-derived classes.
- 7 **Fixed** (419f63d): per-message work scales with what changed (refcount holding, pointer memcmp); perf_bsearch
  6.2 s -> 1.0 s. perf_held6k stays a visible error at the sync cap.
- 12 **Fixed** (419f63d): one candidate call at a time across test threads; stray candidate threads are a grader error.
- Weakrefs (found in the adversarial pass) **Fixed** (925ac73): test-side weak references die as in one process, else
  `Inexact`.
- 2 **Fixed** (e8b7139): the window remedy raises the cap that cut the reply and says both values.
- 3 **Fixed** (8025131, e8b7139, 92bc010): suggestion sized by compaction's rule; `POST /api/sessions/:id/retry`
  re-runs the refused request (or the refused step mid-run); the trace says whether the refused message was kept.
  Live: 13,878-token paste at 8K -> 32K suggested, retried, counted = server, answered correctly.
- 8 **Fixed** (8025131, 9a0f621): tokenizer failure -> estimates that err high (>= 1.09x real on 25 text kinds), held
  to the window, one warning per run.
- 9 **Fixed** (8025131, 92bc010): Stop cancels a count; estimates for the rest of the run after one failure; 20 s
  timeout (120 s for a run's first count, which may wait on a model load).
- 10 **Fixed** (a4ea414): `Promise.race` then recount. 11 **Fixed** (8025131, e8b7139): 409 "environment deleted";
  Send/Continue/Retry disabled with the reason.
- Nits **Fixed** (a4ea414, e8b7139, af15378): net log asks for 5,001 rows; same-millisecond live row kept; pid-only
  krun record must name the env's own disk; verify_datasets timeout 2 x case timeout.

Known residual gaps (documented in guest/README.md; each needs an unusual assertion): `type()` of candidate functions,
modules and generators; logging handlers; stdlib state changed without mock.patch; locale/tzset; candidate exception
tracebacks; weakrefs to slotted classes; `id()` of a dropped and returned object.

## Tests after fixes (macOS)
Backend 199: 197 pass, 2 skipped (gated). grade tests 32/32; review 4 probes 39/39; review 3 probes match plain
(perf_held6k documented); verify.ts all pass; HumanEval 164/164, MBPP 427/427; guest/verify.sh policy 16/16,
vm.test.ts 21/21; VM + reaper 28/28; UI 13/13; tsc clean; vite build OK.

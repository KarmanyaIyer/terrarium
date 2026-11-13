# TODO 6: review 2 grading fixes (#1, #2, #10, #12, test portability)

Date: 2026-10-29. Session: 1a2b8b80-2d5a-4c1f-bf3f-ef89b81cfec1.

## TODO
- [x] Baseline repros on f47fc4a-era code (local grader)
- [x] #1 caller mutation through the RPC
- [x] #12 RPC mismatches (subclasses, deep values, fake builtins, per-call timeout)
- [x] #2 hidden tests read a root-owned source copy
- [x] #10 command checks never run as root or as the grader uid
- [x] fake-results test portability
- [x] Regression tests; full verification
- [x] Commit (packages/shared comment left uncommitted: another agent's hunk in the same file)

## Baseline (before any change)
| Repro | RPC grader | plain unittest |
| --- | --- | --- |
| fix-inventory reference + `self.stock = stock if stock is not None else {}` | 6/6 pass | 1 failure |
| refactor-report: original loops + `_summarize` + overwrite own file on import | 3/3 pass | n/a |
| implement-lru as `class LRUCache(OrderedDict)` (common idiom, correct) | 1/6 (`'dict' object has no attribute 'put'`) | 6/6 |

The last row was not in the review: any candidate class deriving from a built-in data type was flattened to
the base type on the way to the tests, so a correct OrderedDict-based LRU failed. Fixed under #12.

## What changed and why
- `grade_rpc.py`
  - Linked containers (#1): a list/dict/set/bytearray (or subclass) the test passes gets a link id. The
    candidate decodes it into its own real container; after every message the candidate re-encodes each
    linked container, and sends the new contents of any that changed (`sync`); the test writes them back
    into its own object in place. Covers mutation during the call, after a raise, before a callback, and
    later through an object that kept the container (the fix-inventory case). Aliases, cycles and
    `f(xs) is xs` work. Links are dropped when the candidate no longer holds the container (refcount,
    calibrated at startup because 3.14+ counts differently: 3 on 3.12/3.13, 2 on 3.15). One-way by
    design: test changes reach the candidate only when the test passes the container again (no push of
    test state the test didn't send).
  - Hybrids (#12): a candidate object whose class derives from a built-in data type arrives as an instance
    of that base type with its data plus a reference. `==` and `in` are answered locally from the data
    (mutable data is re-read when candidate code ran since), so the candidate still never sees a value the
    test asks it to match; methods, attributes and the rest of the protocol go to the candidate.
    namedtuple `.x`, IntEnum `.name`, list/OrderedDict subclasses with methods all work.
  - `GraderError(BaseException)` with `CandidateGone`, `Unsendable`: grader failures can't satisfy
    `assertRaises(Exception)` or `assertRaises(ValueError)`. Before, a dead candidate inside
    `assertRaises(Exception)` passed, and a too-deep return value passed `assertRaises(ValueError)`.
  - Fake builtins (#12): exception class paths come from identities captured before candidate code runs;
    a candidate class claiming `builtins.ValueError` is reported as `builtins(redefined).ValueError`.
  - Found while working: `Ref` attribute names `_id`, `_c` (and the helper method names) shadowed the
    candidate's attributes of the same name; Ref now forwards every non-dunder name. A candidate class name
    with a NUL made the test side's `type()` raise ValueError mid-decode (catchable by assertRaises); any
    local error while decoding is now a protocol error and names are sanitized. Slices cross by value; an
    OrderedDict keeps its order on the way in.
- `grade_runner.py`: `--source` (what `terrarium_grading.workspace` points at) and `--budget`: a call may run
  until the budget; one still running then fails, and the counts are written. Grader failures are summarized
  by their own line, not a chained TimeoutError.
- `grade.py`
  - #2: copies /workspace twice before any candidate code runs: `src` (root-owned, sealed: agent files
    chowned to root and made read-only, others keep owner/mode, set-id bits dropped) for the tests, `ws`
    (agent-owned) for the candidate.
  - #12: passes `--budget` (timeout minus min(5 s, 10%)) instead of the fixed 30 s per call.
  - Portability: a results file next to a runner that exited non-zero is ignored (the runner exits 0
    right after writing; in --local mode the candidate is the same user and can pre-write the file).
  - #10: `--command` mode: kill agent+grader processes, run `bash -c` as agent in /workspace with
    PATH of root-owned dirs only and a fresh empty HOME (no ~/.local/bin shims, dotfiles or user site),
    kill what it started, JSON result.
- `graders.ts`: VM `command` checks go through `grade.py --command`; hidden files are never written for
  them. Sim command checks unchanged.
- `validate.ts`: command checks that mention `/grader` or come with hiddenFiles are rejected, pointing at
  `tests` checks. All built-in suites still validate (command checks exist only in sim suites).
- Docs: DESIGN.md (check types, "model-written code never runs as root or as the uid that can read hidden
  tests"), guest/README.md (grade.py layout, links, hybrids, grader errors, command mode).

Design choice on #10: the brief suggested a fresh copy; I ran in /workspace directly. Command checks are
written with absolute `/workspace/...` paths (all existing ones are), which would bypass a copy anyway, and
with agent processes dead the copy protects nothing extra. The protections are the uid (agent, can't read
/grader), the clean PATH/HOME, the kill before, and the validator.

## Tests
New (each fails on the old helpers, checked by running the new test files against `git show HEAD:` copies
of grade*.py, except the "candidate __eq__/__contains__ can't claim a match" guard, which passed before
because subclasses were flattened):
- `grade-rpc.test.ts` (12): argument mutation (in place, nested, identity, aliases, cycle, before a raise,
  seen by a callback, bytearray), kept-and-changed-later, subclasses/hybrids, local `==`/`in`, deep value,
  grader errors vs assertRaises, fake builtins.ValueError, proxy-internal attribute names, NUL class name,
  slices + OrderedDict order, 31 s call allowed + hang reports per-test counts.
- `grade-local.test.ts`: fix-inventory alias 5/6 (plain unittest agrees), refactor source swap 2/3,
  fake-results now targets its own job dir on every platform and asserts "results file ignored".
- `graders.test.ts`: VM command check goes through grade.py --command as root helper; pass logic.
- `suites.test.ts`: `/grader` command checks and command checks with hidden files rejected.
- `vm.test.ts` (real VM): fix-inventory 6/6 vs alias 5/6; refactor swap 2/3 with `WROTE ws` / `denied src 13`;
  command check runs as uid 1000 with clean HOME/PATH, can't read /grader, ignores a ~/.local/bin/grep
  shim, agent daemon dead before it runs; nothing left in /var/lib/terrarium-grade.

Results (final code):
- `node --test` in apps/backend: 147 tests, 146 pass, 0 fail, 1 skipped (VM suite, opt-in).
- `guest/verify.sh`: policy 16/16, VM 18/18 (run before the last RPC hardening edits); after them, VM
  boot + both grading tests 3/3.
- `evals/scripts/verify.ts`: 41/41 (every reference passes, starters and os._exit cheats fail).
- `verify_datasets.ts`: GSM8K 1319, MMLU 2524, HumanEval 164/164, MBPP 427/427, 0 failures; HumanEval and
  MBPP rerun after the last edit: 0 failures.
- Python 3.15 (`TERRARIUM_PY=python3`): the new RPC/local tests 10/10.

## Hurdles
- dcg blocks `rm -rf`, dynamic redirects and long heredocs: used mktemp dirs, the Edit tool, and a script
  file for the old-helpers comparison.
- A broadened fake-results cheat (glob over the temp dir) forged results into other gradings running in
  parallel (a HumanEval starter "passed", one RPC test flaked). Fixed by targeting only its own job dir.
- A second full `node --test` run hung in `src/envs/vm/reaper.test.ts`, another agent's new uncommitted
  file; stopped it. The first full run (which included it) passed.

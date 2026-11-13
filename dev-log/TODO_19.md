# TODO 19: protected plain grading and containment review

Date: 2026-10-29. Session ID: not exposed to this implementation sub-agent.

Scope: make the in-process unittest verdict resistant to candidate forgery in one bounded hardening round, retain
all correct references and established review verdicts, and audit VM and sim containment in every network mode.

## Checklist

- [x] Read the requested design, guest, review, and prior TODO documents before editing.
- [x] Replace the candidate-owned plain result file with a bounded anonymous report socket owned by `grade.py`.
- [x] Add a permanent plain-run integrity witness, explicit framework/reporter snapshots, guarded process exit,
      protected signal dispatch, and trusted traceback/frame guards.
- [x] Add direct socket/early-exit and signal-frame forgery regressions.
- [x] Update review 5/6 Node, Python, and VM harnesses and remove every `known-lenient` expectation.
- [x] Make the timezone leniency case portable without Alpine tzdata.
- [x] Audit both environment implementations, all three network modes, session/tool routing, host execution,
      resource exhaustion, persistence, trace/log trust, and UI rendering.
- [x] Fix bounded containment gaps: VM manifest staging cleanup, sim aggregate read cap, and exact Node dylib reads.
- [x] Write `qa/CONTAINMENT.md` with evidence, residual risks, and ranked recommendations.
- [x] Rebuild and verify the guest in a temporary `TERRARIUM_DATA`; rebuild the signed app bundle and compare its
      grader files byte-for-byte with the source.
- [x] Run backend, case-harness, real-VM, hand-written reference, HumanEval, and MBPP verification.
- [x] Commit only owned implementation paths, then owned report/TODO paths. Do not push.

## Decisions

- The accepted plain report lives in the root observer. It must be one valid JSON object under 1 MiB, the runner
  must exit normally, and a timeout, early exit, duplicate/fake bytes, malformed report, integrity error, or any
  recorded unittest failure cannot pass.
- Audit hooks do not report ordinary class assignment, so every attribute of unittest execution/result/loader and
  assertion classes, the runner classes, builtins, JSON reporter, and selected module bindings is identity-checked.
- Catchable signals are pre-registered through a protected dispatcher. Candidate handlers keep alarm and raised
  exception behavior but receive `None` instead of the interrupted trusted frame. Candidate reads of trusted
  tracebacks/frames are rejected. This closed a pure-Python signal-frame forgery found during the bounded check.
- Candidate changes to its own function metadata remain legal. Only runner, unittest, JSON, and signal functions
  are protected by identity, which preserves `fn_meta_cand` and the 591 dataset references.
- An isolated pass plus a rejected/failing protected plain run is Inexact. The 24 former known-lenient cases are
  now 23 Inexact and one exact fail (`tz_lenient`); there are zero `known-lenient` expectations.
- Native CPython memory corruption, already-loaded trusted native extensions, and hidden tests deliberately handing
  their own `TestCase`, `TestResult`, or runner objects to candidate code remain explicit boundaries. This round did
  not begin another open-ended adversarial loop.
- Web mode permits arbitrary public exfiltration by design. Registries mode limits destinations and methods but is
  still data release to listed operators. Network off remains the confidentiality mode.

## Hurdles

- A first anonymous-socket design was forgeable because the child could write a complete report and call
  `os._exit(0)`. The final protocol appends the trusted report and requires a normal runner exit, so injected bytes
  make the stream invalid.
- A final bounded probe found that Python signal handlers receive the interrupted frame and could mutate the live
  `Results` object. Signal virtualization plus trusted-frame guards closed it; the exact exploit is a regression.
- The first function-attribute audit rule rejected correct candidate `__defaults__` changes in `fn_meta_cand`.
  Protecting trusted function identities instead restored the case.
- Homebrew Node 26 linked dylibs and an OpenSSL config outside its install prefix, so sim workers initially failed
  before tests. The profile now resolves only the active binary's non-system dylib directories and uses
  `OPENSSL_CONF=/dev/null`; isolation remains deny-default.
- The final-image VM run first reported 22/23 because its review 5 assertion required unrestricted traceback
  reflection in an already-inexact case. The independent case harness still verifies ordinary unittest semantics;
  the protected VM assertion now requires exactness for every pass-expected case and permits protected rejection
  only where the established verdict is already non-pass.

## Verification

- `pnpm --filter @terrarium/backend typecheck`: clean.
- Backend test suite: 229 total, 227 passed, 2 VM-gated skipped, 0 failed.
- Review harnesses: review 5 88/88; review 6 58/58; known-lenient 24 before, 0 after.
- Dataset references: HumanEval 164/164; MBPP 427/427; 0 failures.
- Hand-written references: 41/41, `all passed`.
- Guest build: verified image `4163e122-15ea-5769-a9bc-7881147f09f1` in temporary data.
- Real VM policy: 16/16. Final full VM: 23/23.
- Focused final-image VM review 5 rerun: 2/2 (boot plus all review 5 cases).
- Sim isolation: 8/8. Sim checkpoint/read-cap tests: 4/4.
- `scripts/package.sh --no-install`: signed 355 MB app; bundled `grade.py` and `grade_runner.py` match source.

## Commits

- `b14eb5f` protected grading, review expectations, containment fixes, and tests.

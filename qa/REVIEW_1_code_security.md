# Review 1: code + security (independent, Opus 5.5 on the Legion, 2026-10-29, commit f107753)

Status: all 11 fixed (2026-10-28). Each item ends with a **Fixed:** line naming the change and the test that proves it.

## High
1. **Graders run candidate code as root, pass on exit code alone.** `apps/backend/src/evals/graders.ts:80`;
   checks in `evals/suites/coding.json`, `evals/suites/convert.ts:15`. `python3 /grader/test_hidden.py` imports the
   candidate module in-process as root; `import os; os._exit(0)` in the module passes the hidden test (verified).
   Fix: kill all uid 1000 processes, copy workspace, run tests as a separate grader uid, run candidate in a subprocess,
   pass only on a results file the candidate can't write showing the expected count of passing tests.
   **Fixed** (6a57b50): new check type `tests`. guest `grade.py` (root) kills every uid 1000 process, copies the
   workspace, runs the candidate in a worker as agent and the hidden tests in a runner as a new `grader` user (uid
   1001, `python3 -I -S`) over an RPC socket, so expected values never enter candidate code; pass = runner's results
   file (grader-only dir) shows passed == expected > 0. Coding, HumanEval and MBPP all use it. Tests: `vm.test.ts`
   "grading: ... cheats fail" (os._exit, sys.exit, results forgery, a daemon swapping in the reference),
   `grade-local.test.ts` (4 cheat families), `evals/scripts/verify.ts` (starter fails, os._exit cheat fails, every
   reference passes), `verify_datasets.ts` (HumanEval 164/164, MBPP 427/427 with cheat checks).
2. **Root file reads can race into host OOM or a wedged VM** (plausible). `envs/vm/driver.ts:465-469`; callers
   `harness/observer.ts:91`, `files.ts:111`, `graders.ts:94`. stat then `vm.fs.readFile`; sandboxd opens without
   O_NOFOLLOW/O_NONBLOCK; host buffers without cap/timeout. Swap file <-> symlink to /dev/zero, or a FIFO.
   Fix: read agent-controlled paths via a root helper using openat O_NOFOLLOW|O_NONBLOCK, fstat S_ISREG, size cap,
   exec timeout (the observer already does this).
   **Fixed** (6a57b50): guest `read.py` reads component-wise with O_NOFOLLOW (root reads) or as the agent,
   O_NONBLOCK, fstat S_ISREG, per-file and batch caps, 30 s exec timeout; the observer batches 200 paths per call.
   Test: `vm.test.ts` "host reads never follow the agent into a FIFO, a device or a root-only path".

## Medium
3. **Sim registries mode leaks DNS.** `envs/net-proxy.ts:95-107` resolves before `checkRequest`. Data exfil via
   lookups of `<data>.attacker.example`; `.local` triggers mDNS on the LAN. Fix: check policy without IPs first.
   **Fixed** (30e6e88): policy runs before any lookup; the resolver is injectable. Test: `net-proxy.test.ts`.
4. **Agent processes survive timeouts and run end.** `guest/files/usr/local/libexec/terrarium/kill:18-19` only kills
   pgroup/session; `setsid` escapes and keeps running into grading. Fix: `pkill -KILL -U 1000` (or cgroup) on
   timeout, abort, run end, and before grading.
   **Fixed** (6a57b50): every exec runs in its own cgroup (`cgroup.kill` on timeout/abort); `kill-user agent` kills
   all uid 1000 processes at run end (sessions) and before grading. Tests: `vm.test.ts` "setsid escapes don't
   survive ...", `sessions.test.ts` (kill at run end).
5. **Sim checkpoints fail once a file reaches ~12 MiB.** `envs/sim/worker.ts:28,160-166`, `runtime.ts:253-256,294`:
   one base64 JSON line per file exceeds MAX_LINE 16 MiB; later files lost on restart; only a warning. Fix: chunk
   content or cap file size; surface checkpoint failures in the trace.
   **Fixed** (59e64d3): files cross the pipe in 3 MiB pieces (dump, load, readFile, writeFile); old state files
   with whole-file entries are split on load; a failed save is appended to the command's stderr. Test:
   `sim/checkpoint.test.ts` (13 MiB file across stop/start, 14 MiB old-format entry, failed save in stderr).
6. **Blob route has no CORS headers.** `server/http.ts:145`. UI diff/raw SSE fetches blocked cross-origin.
   Fix: `baseHeaders(origin)` on the blob response.
   **Fixed** (63337f5). Test: `http.test.ts` "blobs carry CORS headers".
7. **2-VM cap bypass.** `envs/manager.ts:436-439`, `envs/vm/driver.ts:741-747`, `manager.ts:335-347`: seeding during
   fork/create boots via `rt.start()` skipping `makeRoomForVm` and the env mutex; concurrent starts race.
   Fix: seed via `this.start()`, one global lock across count check + boot.
   **Fixed** (c908f7f): one VM boot lock across the count and the boot; VM drivers no longer seed; create and fork
   seed through the managed start/stop. Test: `manager.test.ts` (4 seeded creates, 5 starts, 3 seeded forks at once:
   peak 2).

## Low
8. Malformed URI escape crashes the backend: `server/http.ts:279` `decodeURIComponent` outside try (verified exit 1).
   **Fixed** (30e6e88): decoding is guarded, 400 "malformed percent-escape in path". Test: `http.test.ts`.
9. Unbounded host disk growth: every HTTP decision -> DB row + event with no rate limit (`envs/vm/net.ts:202`,
   `net-proxy.ts:111`); full manifest blob per changing tool call (~4 MB at 20k entries, `harness/observer.ts:152`);
   blobs never GC'd (`sessions.ts:355-360`). Fix: aggregate repeated denials, manifest deltas, blob GC.
   **Fixed** (8765cb9): identical net decisions within 60 s collapse into one row with `repeats` (migration 002;
   DB write and broadcast at most once a second; the trace keeps the first event); manifests stored as deltas
   with a full copy every 16 (`store/manifests.ts`); `store/gc.ts` marks every blob a row, payload or manifest
   chain names and sweeps the rest at startup and 30 s after session/env deletion (blobs used in the last 10 min
   are spared; reused blobs get their mtime refreshed). Test: `store/gc.test.ts` (5000 denials = 1 row and <= 5
   broadcasts; delta < 1/50 of a full manifest, exact round trip; GC keeps every kind of reference, removes the rest).
   On the real data dir the first startup GC removed 7 blobs, none referenced (checked against a backup).
10. Answer parsing: `evals/graders.ts:36-45` `choice` takes first standalone A-D ("A careful reading... answer is C"
    -> A), `number` takes last number ("348 units (computed over 2 files)" -> 2). Fix: prefer an `Answer:` line,
    then last standalone letter / last line's number.
    **Fixed** (6a57b50): `finalChoice` / `finalNumber` prefer an Answer line or `\boxed{}`, then a lone letter line /
    the last line's last number outside parentheses. Test: `graders.test.ts` answer parsing.
11. Sim sandbox profile starts from `(allow default)` (plausible): an escape from just-bash could read outside $HOME,
    reach Mach services, signal user processes. Fix: `(deny default)` + minimal allows for node.
    **Fixed** (56b69bd): `(deny default)`; allows exec of the node binary only, reads of the code it runs, the node
    install, system libraries and a few device files, write of /dev/null, signal/info on itself. No network, Mach,
    IOKit. Tests: `sim/isolation.test.ts` (new deny-default test fails on the old profile), sim checkpoint tests and
    the gated e2e (Python WASM in a real sim session) all pass under it.

## Confirmed fine
Policy IP classification; VM DNS-rebinding pinning; per-hop redirect checks; Host header (undici rewrites);
gateway (chat completions only) + oMLX route allowlist; UI escaping of model output.

## Tests on Linux
Policy, VM net hooks, manifest diff, compaction, fallback, stream, gateway, graders, suites: pass (datasets skipped).
Only failures: missing /usr/bin/sandbox-exec (expected on Linux).

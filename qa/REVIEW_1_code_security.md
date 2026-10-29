# Review 1: code + security (independent, Opus 5.5 on the Legion, 2026-10-29, commit f107753)

Status: open. Fix after the integration pass lands (same files).

## High
1. **Graders run candidate code as root, pass on exit code alone.** `apps/backend/src/evals/graders.ts:80`;
   checks in `evals/suites/coding.json`, `evals/suites/convert.ts:15`. `python3 /grader/test_hidden.py` imports the
   candidate module in-process as root; `import os; os._exit(0)` in the module passes the hidden test (verified).
   Fix: kill all uid 1000 processes, copy workspace, run tests as a separate grader uid, run candidate in a subprocess,
   pass only on a results file the candidate can't write showing the expected count of passing tests.
2. **Root file reads can race into host OOM or a wedged VM** (plausible). `envs/vm/driver.ts:465-469`; callers
   `harness/observer.ts:91`, `files.ts:111`, `graders.ts:94`. stat then `vm.fs.readFile`; sandboxd opens without
   O_NOFOLLOW/O_NONBLOCK; host buffers without cap/timeout. Swap file <-> symlink to /dev/zero, or a FIFO.
   Fix: read agent-controlled paths via a root helper using openat O_NOFOLLOW|O_NONBLOCK, fstat S_ISREG, size cap,
   exec timeout (the observer already does this).

## Medium
3. **Sim registries mode leaks DNS.** `envs/net-proxy.ts:95-107` resolves before `checkRequest`. Data exfil via
   lookups of `<data>.attacker.example`; `.local` triggers mDNS on the LAN. Fix: check policy without IPs first.
4. **Agent processes survive timeouts and run end.** `guest/files/usr/local/libexec/terrarium/kill:18-19` only kills
   pgroup/session; `setsid` escapes and keeps running into grading. Fix: `pkill -KILL -U 1000` (or cgroup) on
   timeout, abort, run end, and before grading.
5. **Sim checkpoints fail once a file reaches ~12 MiB.** `envs/sim/worker.ts:28,160-166`, `runtime.ts:253-256,294`:
   one base64 JSON line per file exceeds MAX_LINE 16 MiB; later files lost on restart; only a warning. Fix: chunk
   content or cap file size; surface checkpoint failures in the trace.
6. **Blob route has no CORS headers.** `server/http.ts:145`. UI diff/raw SSE fetches blocked cross-origin.
   Fix: `baseHeaders(origin)` on the blob response.
7. **2-VM cap bypass.** `envs/manager.ts:436-439`, `envs/vm/driver.ts:741-747`, `manager.ts:335-347`: seeding during
   fork/create boots via `rt.start()` skipping `makeRoomForVm` and the env mutex; concurrent starts race.
   Fix: seed via `this.start()`, one global lock across count check + boot.

## Low
8. Malformed URI escape crashes the backend: `server/http.ts:279` `decodeURIComponent` outside try (verified exit 1).
9. Unbounded host disk growth: every HTTP decision -> DB row + event with no rate limit (`envs/vm/net.ts:202`,
   `net-proxy.ts:111`); full manifest blob per changing tool call (~4 MB at 20k entries, `harness/observer.ts:152`);
   blobs never GC'd (`sessions.ts:355-360`). Fix: aggregate repeated denials, manifest deltas, blob GC.
10. Answer parsing: `evals/graders.ts:36-45` `choice` takes first standalone A-D ("A careful reading... answer is C"
    -> A), `number` takes last number ("348 units (computed over 2 files)" -> 2). Fix: prefer an `Answer:` line,
    then last standalone letter / last line's number.
11. Sim sandbox profile starts from `(allow default)` (plausible): an escape from just-bash could read outside $HOME,
    reach Mach services, signal user processes. Fix: `(deny default)` + minimal allows for node.

## Confirmed fine
Policy IP classification; VM DNS-rebinding pinning; per-hop redirect checks; Host header (undici rewrites);
gateway (chat completions only) + oMLX route allowlist; UI escaping of model output.

## Tests on Linux
Policy, VM net hooks, manifest diff, compaction, fallback, stream, gateway, graders, suites: pass (datasets skipped).
Only failures: missing /usr/bin/sandbox-exec (expected on Linux).

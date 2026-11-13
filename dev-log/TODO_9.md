# TODO_9: env concurrency and VMM lifecycle (busy envs, shell in use, eval read-only, VM leaks)

Date: 2026-10-29. Session: 74639a3d-20fa-4d00-b1ce-f7a2ef4d0597 (implementation sub-agent). Owned paths: apps/backend/src/envs/**,
apps/ui/**, packages/shared (one additive type).

## List
- [x] 1 VMs leaked when the shell and backend die together
- [x] 2 snapshot/fork/reset/restore/stop of an env in use shut it down under the running command
- [x] 3 user shell exec not marked in use (making room could stop it mid-command)
- [x] 4 eval-owned env: shell and network still writable mid-grade
- [x] Full backend suite, real VM suite, tsc, vite build; manual kill -9; real UI check

## What changed and why
- **Busy model (2, 3).** `EnvSummary.inUse?: EnvUse[]` (shared, additive): what uses the env now, most binding first:
  `eval` (an `eval_results` row is `running` with this `env_id`: agent run and grading), `session` (a run holds the env
  via `acquire`), `shell` (count of user commands in flight). Computed in `toSummary`, so every env broadcast carries it.
  - Stop, reset, restore (reset with a snapshot), snapshot, fork of the live env (its auto snapshot, also
    `create` with `from: {envId}`) and delete check under the env mutex and answer
    `409 env busy: session "Fix tests" running` (reasons joined with `; `). Fork from a stored snapshot doesn't touch the
    live env and stays allowed (the eval runner relies on it). Delete was added to the list for the same reason.
  - The old "wind the session down" step in reset and stopUnlocked is gone (now unreachable for public calls, and it
    could stop a session that was only waiting in `acquire` for the mutex). `releaseStorage` still winds down a leftover
    session explicitly.
  - Shell `exec` marks the env before its `start` and unmarks in `finally`, broadcasting both. No mutex is held during
    the command. `idleVm` is now "running and nothing uses it", so making room skips shell, session and eval envs. With
    no idle VM the start fails: `2 VMs are in use (dev: session "x" running; scratch: shell command running); stop one first`.
- **Eval read-only (4).** `exec`, a network change and `acquire` by any session other than the case's own answer
  `409 env read-only: eval "Tool basics" case read-file running`. Rename stays allowed. No edits to evals/** were needed:
  the runner already flips the result row out of `running` before its own stop/release.
- **VM leak (1).** `src/envs/vm/reaper.ts`:
  - Guard per running VM: `/bin/sh` reading a pipe only the backend holds; EOF (backend died, any signal) makes it SIGTERM
    the VMM, then SIGKILL after 3 s, but only while `ps -ww -o lstart= -o command=` for that pid still equals what was
    recorded. Armed as soon as `vm.getHostPid()` appears during `vm.start()` (20 ms poll); disarmed (killed) on shutdown,
    failed boot and the next boot. Guard stdout/stderr are `ignore` so the app shell's EOF-on-exit detection is unaffected.
  - Record per VMM in `<data>/run/vmm/<pid>.json` (pid, identity, env, owner backend pid + identity). `loadDrivers` runs
    `reapOrphanVmms` before anything boots: records whose owner backend is still alive are kept (two backends on one data
    dir), others get their VMM stopped if pid + start time + command line still match, then the record and Gondolin's
    leftover `gondolin-krun-runner-XXXXXXXX.json` (temp dir, exact name pattern) are removed.
- **UI.** `lib/envuse.ts` (`busyReason`, `evalOwner`). Environment tab: Stop, Snapshot, Fork, Reset, Delete and snapshot
  Restore are disabled while `inUse` is set, with the reason as a visible line under the actions and as the tooltip;
  Fork from a snapshot stays enabled. Eval-owned env: Environment and Network tabs show the mode as text with a
  `read-only: eval running` chip; Shell tab input and Run disabled with the reason as the placeholder; the session header
  network switch is static. New environment sheet: Fork from a busy env shows `busy: <reason>` and Create is disabled.
  The old UI check (`sessions` list with `status === running`) missed eval sessions and shell commands; now it reads the
  backend's field.

## Tests
- New, fail on the old code (checked by running them against `git show HEAD:...manager.ts` / `driver.ts` copies):
  - `manager.test.ts` "an env in use refuses stop, reset, restore, snapshot, live fork and delete...": for session, shell
    and eval use, each of stop/reset/restore/snapshot/fork/create-from/delete is 409 with the exact reason and the VM
    stays up; stored-snapshot fork works; use clears and is broadcast. Old: "Missing expected rejection: session: stop".
  - `manager.test.ts` "a VM running a shell command isn't stopped to make room...". Old: no 409, B stopped under the
    command ("stopped under the command").
  - `manager.test.ts` "an env owned by a running eval case is read-only...". Old: exec accepted.
  - `reaper.test.ts` (new file, fake VMMs are `sleep`): guard kills on backend SIGKILL; disarmed guard leaves the pid;
    startup reaping kills the orphan only, not a reused pid (other start time), not another command line, not a live
    backend's VMM; malformed records dropped.
  - `reaper.test.ts` real krun (TERRARIUM_VM_TESTS=1): backend SIGKILL -> runner gone; backend and guard SIGKILL ->
    runner survives, then `reapOrphanVmms` stops it and removes both runner configs. Old driver: "krun runner outlived its
    SIGKILLed backend" (left pid 15518 orphaned under launchd; killed by hand).
- Backend full `node --test`: 152 tests, 150 pass, 0 fail, 2 skipped (gated e2e and real-krun reaper test). Real VM
  suite (`TERRARIUM_VM_TESTS=1`, `vm.test.ts` + `reaper.test.ts`): 22/22.
- tsc clean (backend, UI); `vite build` OK. src-tauri untouched (no clippy run needed).
- Manual, temp data dir `/tmp/terr9-data` (images symlinked), backend started detached (parent launchd, own group):
  - kill -9 backend with a VM up: krun gone in under 1 s, record left; next start dropped the record.
  - kill -9 backend and guard together: krun reparented to launchd and kept running; fresh start logged
    "stopping VM ... its VMM (pid 26514) outlived backend pid 26461" and it was gone. Nothing left afterwards.
  - Graceful SIGTERM: VM, guard, oMLX and record all gone.
- Real UI (Brave via wb, vite dev + this backend, Qwen3.5 4B): session run with `sleep 30` on a VM env: Stop, Snapshot,
  Fork, Reset, Delete, Restore disabled with `session "busy check run" running` shown; API snapshot 409 with that
  reason; all re-enabled live when the run ended. Shell tab `sleep 15`: same with `shell command running`; reset 409.
  Eval ownership (row injected into the temp DB): Env/Network show `read-only: eval running`, Shell input disabled with
  the reason; exec and network PATCH 409.

## Hurdles
- dcg blocks heredocs that contain backticks or `${}`; used the Edit tool.
- A first version of the startup-reap test waited for the exit of `sleep 0` after it had already exited and hung. The
  grading agent's full-suite run (pid 14114) picked up that version and hung on it; it later went away on its own.
- The krun runner is codesign-checked for the hypervisor entitlement, so a wrapper script around it isn't possible; the
  guard is a sibling process instead.

## Noticed, not fixed
- `diskBytes` ("On Mac disk") is cached at create time (0 B before the disk exists) and only refreshed on stop/release/
  reset, so a new env shows 0 B until its first run ends.
- `GET /api/envs/:id/tree` while an env is still being created logs a 500 ("no VM env storage").
- One malformed `eval_runs` row (`config_json` without `modelIds`) makes `/api/state` and the WS hello fail
  (`evals.list()` throws). Seen only with a hand-inserted row.
- Older `gondolin-krun-runner-*.json` files from earlier sessions remain in `$TMPDIR` (not ours to delete; the startup
  reaper only removes those of VMMs it has records for).

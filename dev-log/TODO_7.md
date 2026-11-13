# TODO_7: Review 2 fixes (backend and app lifecycle: #3, #5, #6, #7 server, #11)

Date: 2026-10-29
Session: 0007fc8b-bb75-474e-a758-93bf14aa3f00 (implementation sub-agent)

## TODO
- [x] #5 events route returns the whole history (358e7a2)
- [x] #7 net log ordered by latest attempt (63dae6a)
- [x] #11 request blob named from the call start (d2c11a7)
- [x] #6 VM cap across snapshot/fork/reset; victim mutex; seeding under the env mutex (28f222c)
- [x] #3 oMLX and the backend's process group die with the backend (b87ed7d)
- [x] Full backend suite, real VM suite, tsc, cargo build/clippy, manual kill -9 checks

## What changed and why
- **#5** `GET /api/sessions/:id/events` without `limit` reads 5000-event pages until a short one and returns
  everything after `after`; with `limit` it still returns one page (cap 20000). The non-paging caller was the
  UI client (`apps/ui/src/api/http.ts:140`, not the backend's http.ts), so fixing it server-side needed no UI change.
- **#7** `netLog` orders by `COALESCE(last_ts, ts) DESC, ts DESC`. Response shape and `limit` unchanged. Aggregation
  untouched; the test checks that an allow to the same URL stays a separate row from the deny loop.
- **#11** `model_call_start` carries `requestBlob` (optional field added to `packages/shared`). The event is
  persisted at once and GC marks any 64-hex token in payloads, so the request survives a sweep during a long call.
- **#6**
  - VM driver `snapshot()`/`restore()` stop a running VM and leave it stopped (the driver no longer boots on its own).
  - Manager `keepRunning()` takes the VM boot lock before the VM goes down and restarts it before releasing the lock,
    so the VM keeps its slot. Used by snapshot (so also fork's auto snapshot and create's factory snapshot) and reset.
    A failed restart marks the env `error`.
  - `boot()` replaces `makeRoomForVm`: count + boot under the boot lock. With no free slot, it returns the least
    recently used idle VM, stops it outside the boot lock under that VM's own mutex (re-checked there), and counts
    again. Nothing waits for an env mutex while holding the boot lock, which rules out the deadlock (a snapshot or reset
    holds its env mutex and waits for the boot lock).
  - Seeding holds the env mutex across start, writes and stop (before, another start could stop a VM mid-seed).
  - Reset winds down the active session before taking the boot lock (session stop can wait up to 15 s).
- **#3**
  - `backend.rs` keeps `pgid` apart from `pid`. On an unexpected exit the watcher sends the group SIGTERM, waits up to
    3 s, then SIGKILL. `stop()` always reaps the group, even when the backend is already gone. The group id is forgotten
    once the group is confirmed empty, so a later stop can't signal a group that reused the id.
  - oMLX gets a stdin pipe the backend never writes to. `omlx_serve.py` starts a watchdog thread (env
    `TERRARIUM_PARENT_STDIN=1`) that SIGTERMs itself on EOF or reparenting, with a hard exit after 10 s.
  - Also fixed the pre-existing clippy `single_match` in the handshake reader.

## Tests
- New, all fail on the old code:
  - `http.test.ts` "#5" (12,345 events; old: 5000)
  - `gc.test.ts` net log block (old: the loop drops out of the newest 5)
  - `gateway.test.ts` "#11" (old: "request blob survives the sweep" fails)
  - `manager.test.ts` 4 new tests: snapshot/fork/reset interleavings with the fake driver both rebooting itself (old
    driver) and not (old: peak 3 VMs, or a status that says running for a VM that's down), deadlock check, seeding
    vs. making room (old: 409 / stopped halfway).
- Backend `node --test` (full): 130 tests, 129 pass, 0 fail, 1 skipped (gated e2e). Real VM suite
  (`TERRARIUM_VM_TESTS=1`): 17/17. tsc clean (backend, UI). `cargo build` and `cargo clippy`: 0 warnings.
- Real manager + real VMs (ad-hoc `/tmp/terr-proc/realvm.ts`): snapshot, fork and reset of a running VM bring it
  back with the right disk contents; starting a third VM stops the idle one; peak 2.
- Manual #3 (temp data dirs, never the shared `data/`):
  - Standalone backend, oMLX with the 2B model loaded (1.5 GB RSS): after `kill -9` of the backend, oMLX was gone in 1 s.
  - Debug Tauri binary (`target/debug/terrarium`): `kill -9` of the backend left oMLX (1.38 GB) gone in 1 s and the
    shell logged reaping the group.
  - "Restart backend" then gave a clean new backend.
  - With oMLX running again, Quit left nothing.
  - With the watchdog disabled, the shell's group reap alone killed oMLX in 1 s.

## Hurdles
- First watchdog run: oMLX survived. Its `print()` hit a broken stdout pipe (stdout goes to the dead backend) and the
  thread died before `os.kill`. The print is now guarded.
- Getting the token of a Tauri-spawned backend: `TERRARIUM_NODE` pointed at a wrapper script that saved it.
- The backend listens on two ports (API and gateway); the first `lsof` hit was the gateway.

## Noticed, not fixed
- A krun VM runner outlives a SIGKILLed parent (verified: reparented to launchd). The app's group reap covers a
  backend crash, but if the shell and backend die together (e.g. `killall -9`), VMs leak until reboot. Possible fix:
  record VMM pids and kill stale ones at backend startup.
- Snapshot or fork of a busy VM shuts it down under the session's running command (pre-existing; manager.snapshot
  doesn't check `active`).
- User shell `exec` runs without the env mutex and without marking the env active, so making room for another VM can
  stop a VM mid-command (pre-existing).

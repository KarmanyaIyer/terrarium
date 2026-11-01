# TODO_22: resource budgets, LFM3, Neuron Lab, UI overhaul

Date: 2026-10-31
Session: 4d7fa632-b05e-4dbb-857c-d7d9f81d874f (T3 thread 2f9ddd9e-65f4-42e4-9a56-0b40299173e2)

## TODO
- [x] Cleanups: ~/PRIMARY/Projects/local_llms (9.3 GB) moved to Trash (dcg blocks rm -rf). /tmp/terrarium-*,
      the Trash duplicate image and the $TMPDIR e2e folder were already gone.
- [x] Resource budgets (qa/CONTAINMENT.md recs 1-3) + LFM3 (Daybreak Blue agent, record TODO_20.md)
- [x] Neuron Lab: probe, find, steer, recipes, steered model in sessions/evals (Opus agent, record TODO_21.md).
      Takes over thread 9d0871b5 ("How one neuron makes an owl", _scratch27 fb7c359).
- [x] App-wide UI/UX overhaul with terrarium/lab theming (Opus agent, after the Lab lands)
- [x] QA (TODO_22 Final QA), session request budget default 200 -> 2000, repackaged from 7b3b4bf, launch + quit clean, pushed to legion

## Fixes by me
- Rename fallout: 6 VM/snapshot qcow2 headers still pointed their backing file at .../g-terrarium/...; rebased
  header-only (`qemu-img rebase -u -F raw -b <new rootfs.ext4>`). Real VMs would not boot before this.
- Lab: cached calibration arrays from mx.load are now evaluated in the load thread (lab_core.py _calibrate). The UI
  agent saw neuron() fail with "There is no Stream(cpu, 0) in current thread" on a cached calibration; a two-thread
  repro did not trigger it, so final QA verifies against the real sidecar.

## Decisions and why
- LFM3 (checked 2026-10-31): mlx-lm PR #2016 still open (third-party author, no maintainer review), latest
  release still 0.32.2. Plan: review the 262-line lfm3.py as untrusted code and vendor it with an install step,
  rather than wait.
- Lab and budgets run concurrently in the shared checkout (worktree isolation unavailable from this scratch
  thread); the UI overhaul waits for the Lab so one designer pass covers everything.

## Final QA (2026-11-01)
Session: 6646da05-5631-402b-8d28-5be566329f3a (review sub-agent). Reviewed 315c0a5..4b60c77; independent integration
code review by an Opus sub-agent, then live checks on the real data dir (DB backed up to data/terrarium.db.bak-fqa).

### Findings and fixes
| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| 1 | High | VM disks keep an absolute backing path; a moved data dir stops every VM from booting | Fixed `5ab49e4`: boot repoints a disk whose base image moved (header-only `qemu-img rebase -u`, only when the old path names an image object present under the current data dir, else a clear error). Test `envs/vm/backing.test.ts`; live: a clone of vm-1 re-pointed at the old g-terrarium path booted in 1.7 s after the repoint |
| 2 | Medium | Home's model menu hides strains but its default could be a strain: Run an agent started a session on a strain while showing another model | Fixed `79b6599` (`defaultModel({ strains: false })`), confirmed live before the fix |
| 3 | Medium | A mid-stream error event (Lab or oMLX, after 200 headers) was recorded as finish "stop" with no error | Fixed `b193a56`, gateway test added |
| 4 | Medium | UI fit estimates ignored the Lab's specimen, so pickers said "fits" where the backend unloads or refuses | Fixed `791011a`: Lab counted once (strain residentBytes, else sidecar RSS); `apps/ui/test/memory.test.ts` |
| 5 | Medium | Lab memory check counted a running session's not-yet-loaded model at its default context with no overhead; beforeOmlxLoad uses the session window plus overhead | Fixed `4801f06`; test fails without the fix |
| 6 | Low | Lab support only read `model.safetensors.index.json`; a single-file LFM build would show as supported and fail at load | Fixed `6665fc2`: names from the safetensors header; test |
| 7 | Low | Home Steer card: "about 4.5 GiB., 1 strain"; tooltip said "not installed" for an unsupported model | Fixed `79b6599` |
| 8 | Test flake | sessions.test "agent loop" failed about 1 in 5 runs, also before these streams: a local port prober (some node process on this Mac sends `GET /` with trace headers to new localhost ports) took a scripted reply from the fake model | Fixed `ffd7cac`: fake answers only POST /v1/chat/completions; 15/15 after |
| 9 | Lab cache bug | neuron card "no Stream(cpu, 0)" on cached calibration | Not reproducible: real sidecar, two loads of Qwen3.5-4B (second from cache), every op ok, both with and without 4b60c77's eval; through the dev backend and UI too (fresh calibration, unload, reload from cache 1.7 s, neuron card ok). 4b60c77 kept as a cheap guard |

### Verified, no change needed
- Final checks: backend 276 tests, 274 pass, 0 fail, 2 VM-gated skips; UI 25/25; both typechecks clean; vite build ok.
- Migrations 004/005 on a `.backup` copy of the real DB: applied, integrity ok, 97 sessions intact. The dev backend then
  migrated the real DB the same way.
- Real VMs boot through the dev backend on the real data dir: vm-1, vm-1 (fork) (an LFM3 session ran uname/nproc/free
  in it), evalbase_vm.
- Strain sessions go through the same gateway budget path: request_count and trace_bytes recorded for the strain chat.
- Lab refuses LFM3 with the down_proj reason in the specimen picker; LFM3 serves sessions and evals.
- Settings: resource limits match backend ranges; an out-of-range value reverts and is not saved.
- Flows on the dev app (backend 8797, Vite 5173): VM, sim and chat sessions on LFM3 1.7B; Speed eval 3/3 on LFM3
  (25 s); Lab Try the example, Find (L22N2742 first, 16 to 18 s), Probe, Steer compare, Trace, neuron card, Save as
  strain, strain chat with the Lab loaded and with it unloaded (on-demand load, 4.1 s); Settings, Models; light and
  dark. Screenshots /tmp/fqa/shots. Backend shutdown left no sidecar or oMLX process.

### Open (not changed: design calls or low value)
- Session budgets last a session's whole life (200 model requests by default). A long interactive chat hits a hard
  "budget" stop until the limit is raised in Settings. Intended per TODO_20, but 200 is low for interactive use.
- oMLX's own memory guard is set from the full ceiling at start; the Lab's share is enforced only in beforeOmlxLoad,
  and a ceiling change is not re-checked against a running Lab.
- `labSupport()` reads every model's config and index synchronously on state(), heldBytes() and each oMLX call while
  the Lab is up; cache per catalog scan if it shows up in profiles.
- Sim worker cap: bootSim throws 409 at the cap instead of queueing, so eval cases fail as errors if interactive sims
  hold every slot (cap minimum 1).
- Storage panel has no row for data/lab (calibration cache, sidecar.log; 6 MB per model).
- Memory on this Mac was tight during QA (another agent's iOS Simulator); Qwen3.5 4B at 32K showed "Won't fit" in
  sessions, which is the fit check working.

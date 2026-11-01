# TODO_22: resource budgets, LFM3, Neuron Lab, UI overhaul

Date: 2026-10-31
Session: 4d7fa632-b05e-4dbb-857c-d7d9f81d874f (T3 thread 2f9ddd9e-65f4-42e4-9a56-0b40299173e2)

## TODO
- [x] Cleanups: ~/PRIMARY/Projects/local_llms (9.3 GB) moved to Trash (dcg blocks rm -rf). /tmp/terrarium-*,
      the Trash duplicate image and the $TMPDIR e2e folder were already gone.
- [ ] Resource budgets (qa/CONTAINMENT.md recs 1-3) + LFM3 (Daybreak Blue agent, record TODO_20.md)
- [ ] Neuron Lab: probe, find, steer, recipes, steered model in sessions/evals (Opus agent, record TODO_21.md).
      Takes over thread 9d0871b5 ("How one neuron makes an owl", _scratch27 fb7c359).
- [ ] App-wide UI/UX overhaul with terrarium/lab theming (Opus agent, after the Lab lands)
- [ ] QA, repackage, commit, push

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

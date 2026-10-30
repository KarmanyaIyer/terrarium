# TODO_17: rename, Switchboard, app UX round, plain-run safeguard, README

Date: 2026-10-29
Session: 4d7fa632-b05e-4dbb-857c-d7d9f81d874f (T3 thread 2f9ddd9e-65f4-42e4-9a56-0b40299173e2)

## TODO
- [x] Switchboard: removed the Local models card, its supervisor script, test and doc (s-switchboard df5db66). Kept
      the generic stopGraceMs support. Someone else's uncommitted continuity work there left untouched (only my hunks
      staged via a patch).
- [x] Repo renamed g-terrarium -> terrarium (Mac and Legion). Fixed absolute paths in .venv (79 files), data/omlx
      settings.json, snapshots.path in the DB; pnpm links refreshed; Legion repo + review worktree moved; remote URL
      updated. Backend 216/218 (2 gated) after the move.
- [x] Temporary link ~/PRIMARY/Projects/g-terrarium -> terrarium so the installed app (repo path baked in at build
      time via CARGO_MANIFEST_DIR) keeps working until the final repackage. Remove after repackage.
- [x] Legion git identity set to the Mac's (KarmanyaIyer, GitHub noreply email)
- [x] App UX round (Opus agent, TODO_18.md): settings page, add/remove model, per-session system prompt + Prompt tab,
      harness labels + hover cards, VM vs sim guidance + toggle help, models table regrouped, evals page redesigned
- [x] QA (Opus agent): 4 bugs fixed (oMLX reload aborted running sessions on download/remove; downloads could exceed
      the size check via nested files; Prompt textarea one line tall; ceiling change not reflected until reload) + one
      low (unsaved prompt edits wiped). Live checks passed with Qwen3.5 4B (exact prompt 174 + tools 583 = 757 tokens,
      override reaches the raw request, cancel cleans up, remove while another model loaded is safe). da490bf, 01b64af
- [x] QA leftovers fixed by me (4139431): Restart oMLX disabled while sessions/evals run, failed downloads dismissable
      and canceled ones hidden, storage bar and legend share one order, eval history shows full harness label, env
      picker border, settings row wrap, tool token copy notes the chat template's extra instructions, sim RAM 50-90 MiB.
      Sim Python 3.13 confirmed (bundled CPython WASM reports 3.13.2)
- [x] Plain-run safeguard + containment check (Daybreak Blue agent, TODO_19.md): hit the Codex usage limit twice;
      T3 resumed it after the 22:12 reset. Plain verdict now comes from the root grade.py observer over an anonymous
      socket (one JSON result after a normal exit; integrity checks on framework objects). Known-lenient 24 -> 0 (23
      now Inexact, 1 exact fail). Backend 227/229 (2 gated), review 5 88/88, review 6 58/58, HumanEval 164/164, MBPP
      427/427, VM suite 23/23. Containment review in qa/CONTAINMENT.md; 3 small fixes (VM manifest staging cleanup,
      sim batch-read cap, narrower Seatbelt dylib reads). b14eb5f, a2cfd1f
- [x] README with screenshots and diagrams (c2ad4e6)
- [x] Repackaged from 2091e68 (new repo path baked in), compat link removed, launch + quit clean (no leftover
      processes), Settings screenshot retaken from the installed app, pushed to legion

## Open (user's call)
- Containment residual risk is resource exhaustion, not escape: a hostile model can't reach host files or the
  LAN/localhost, but sim workers have no global RSS/CPU/worker budget and traces/snapshots have no disk quota, so it
  could slow the Mac or fill the disk. qa/CONTAINMENT.md recommendations 1-3 cover it.
- LFM3-1.7B: add from Models > Add model once an mlx-lm release supports lfm3 (and oMLX picks it up).

## Decisions and why
- LFM3 (Liquid, released 2026-10-27): LFM3-1.7B is the only text model; vendor numbers show BFCL v4 71.4 vs Qwen3.5 4B
  55.1, ~1 GB at 4-bit, 256K context. Official MLX builds exist (LiquidAI/LFM3-1.7B-MLX-4bit/8bit) but mlx-lm has no
  lfm3 support yet (PR ml-explore/mlx-lm#2016 open; latest release 0.32.2 from 2026-10-16). Not installing an unmerged
  third-party PR into the venv. Listed in the add-model suggestions with an "unsupported by installed mlx-lm" check.
  VL/Audio/Omni variants skipped (not text agents).
- Plain-run safeguard goes to GPT Daybreak Blue (user's call). It affects eval score integrity against a model that
  games the grader, not containment.

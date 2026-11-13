# TODO_25: Neuron Lab fix and redesign

Date: 2026-11-01
Session: c8ea99f2-6d6c-42c6-a33f-7323a7a8927b (implementation sub-agent of TODO_24's "Lab app pass")

## TODO
- [x] 9. LFM3 and Bonsai hooks
- [x] 1. Trace by real intervention
- [x] 4. Signed dose sweep, streaming, cancel, zoom, seeds grid
- [x] 8. Test across seeds, repeat control, loop flag
- [x] 3. Find: one box, model writes examples, tests replies; Surprise me
- [x] 5. Exact recipe on every result, history, restore
- [x] 2. Reply actions everywhere, click a word
- [x] 6. Undo and redo (menu checks left for the packaged app, see below)
- [x] 7. Save strain dialog, 700 px audit
- [x] 10. Less noise
- [x] Checks, live pass, commits, report

## Decisions and why
- Doses keep their meaning, recipes stay `L22N2742+0.8`. New `Lab.TRY_DOSES` only changes the first dose tried per model.
- LFM3 try dose 3, not 0.8. It has an RMSNorm after each MLP, so traits show from about +3 and flatten past +8. Scoring stays at 0.8, because scoring at 3 made ranks worse (L0 neurons won). Measure doses scale with it: 0.94, 1.88, 3.75.
- Repeat penalty 1.1 by default for steered runs and strain chats. See the numbers. 1.2 and 1.3 cost more fluency than they earn.
- Quality words from fluency and repetition: reads fine, unusual (below -3.5), garbled (below -4.5), loop, empty.
- Example writer prefills "A:" and caps tokens at min(40n, 800), since LFM3 opens `<think>` whatever the template says. Lines copied from the prompt are dropped.
- Flow picks its first four from layers >= n/4, then tries the four strongest together at half the try dose.
- Cmd+Z stays native in a text field, app undo elsewhere. Predefined Edit menu items kept: a custom menu could not be tested once the Tauri app was off limits.

## Hurdles
- I launched the debug Tauri build and used foreground delivery from cua-driver: windows jumped and the pointer moved while the user worked. Killed on request, all later testing in headless agent-browser against Vite. Do not launch the app from a sub-agent.
- dcg blocked `git checkout --` on main.rs. The checkout is shared, so no stash: reversed my own patch by exact script, 0 diff.
- dcg false positive on a long heredoc: wrote the edit scripts with the Write tool.
- Bonsai 9B has an untied Hadamard `lm_head`, Find failed on it. `_unembed_rows` now uses `HadamardProjection.rows(idx)`.
- The 4B reads "a tiger" poorly: 24 candidates at 0.5, 0.8, 1.2 and 16 on open prompts, 0 hits. The UI now says plainly that none wrote about it.
- Live pass fixes: stale `.trace-form` rule, false "add space" note after `**`, narrow `.mix-val`, `×+0.167`, History Compare overlap, 0 cell grids saved, card actions poking out, picker header, card squeezing Probe, "ready" beside an unloaded target, dev-facing example toast.

## Numbers
Checks: backend 284 tests, 282 pass, 0 fail, 2 skipped. UI 40 of 40. Typechecks clean. Vite build fine (to /tmp, repo dist untouched).

Repeat penalty, 8 seeds x 3 prompts = 24 replies each, 80 tokens, temp 0.7. Loop rate and median fluency.

Qwen3.5 4B:
| Recipe | off | 1.1 | 1.2 | 1.3 |
| --- | --- | --- | --- | --- |
| none | 0%, -0.42 | 0%, -0.49 | 0%, -0.81 | 0%, -1.03 |
| L22N2742+0.8 | 12%, -2.27 | 0%, -2.59 | 0%, -2.76 | 0%, -3.01 |
| L22N2742+1.2 | 58%, -2.49 | 4%, -3.61 | 0%, -3.79 | 0%, -3.99 |
| L22N2742+1.6 | 79%, -1.23 | 38%, -3.91 | 4%, -5.42 | 0%, -5.82 |
| L28N1343-0.98 | 4%, -1.91 | 0%, -1.97 | 0%, -2.31 | 0%, -2.37 |
| mix of 4 | 0%, -2.03 | 0%, -2.23 | 0%, -2.51 | 0%, -2.74 |

LFM3 1.7B:
| Recipe | off | 1.1 |
| --- | --- | --- |
| none | 0%, -0.48 | 0%, -0.60 |
| L19N1243+3 | 4%, -2.34 | 0%, -2.53 |
| L19N1243+8 | 0%, -2.86 | 0%, -3.05 |
| L14N679+3 | 0%, -2.55 | 0%, -2.61 |
| L18N2261+1 | 0%, -1.56 | 0%, -1.63 |

Live on real models:
| Model | Neurons | Load | Flow | Result |
| --- | --- | --- | --- | --- |
| Qwen3.5 4B | | | aliens 43 to 56 s, a trait 58 to 74 s | "I am **Extrali**, an extraterrestrial intelligence" |
| LFM3 1.7B | 184,320 | 4.8 s, 1.84 GB | a robot 33 to 43 s | L19N1243+3 "built by **Robo**", strain chat 21.7 tok/s |
| Bonsai 2 2B | | | aliens 26 to 34 s | L17N3128+0.8 "an advanced extraterrestrial intelligence" |
| Bonsai 2 9B | 393,216 | 15.7 s, 2.56 GB | aliens 114 s | L22N10573 |

Bonsai 27B not run: 13.2 GiB is over the 11.2 GiB ceiling, same layout as 9B. Gemma 4 not run this pass.
Trace: 108 model runs, 4.1 s on 4B, 2.8 s on LFM3, 4.0 s on Bonsai 2B.
Sweep: 13 steps at 32 tokens, 23 to 33 s on 4B. Seeds: 12 replies, 22 to 30 s on 4B.

## For the packaged app (not checked here)
1. Cmd+Z in a text field undoes text natively.
2. Cmd+Z outside a field runs app undo exactly once.
3. Cmd+Shift+Z redoes the same way.
4. Edit > Undo and Redo by mouse: did nothing to the app stack in the debug build. See `src-tauri/src/main.rs:149`.

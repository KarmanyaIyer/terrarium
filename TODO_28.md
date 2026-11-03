# TODO_28: Vector recipes, Field Guide, Grow a character

Date: 2026-11-02
Session: 679b90d4-75b6-4409-9b29-3ce234a5ffd9 (implementation sub-agent)
Input: research/personas/FINDINGS.md and suite.json (read-only, another agent is still writing there).

## TODO
- [x] 1. Vector recipes: sidecar, backend, contract, migration, strains, Compare, Sweep, Seeds, History, Trace, undo
- [x] 2. Strain sessions: thinking off, stop tokens, stored settings, measured through a real chat path
- [x] 3. Field Guide: re-runnable catalog generation, UI, one click to Compare, one click to strain, download offer
- [x] 4. Replace the alien: example applies a recipe, real quote, new presets, docs and leftovers
- [x] 5. Grow a character (generator C) as the box's main path, word search (generator A), progress, cancel, verdict
- [ ] Final: typechecks, tests, vite build, cargo check, live headless pass, re-run catalog at the end

## Decisions
- Vectors keep the settings their numbers were measured with: temperature 0.7, top_p 0.95, no repeat penalty. No measurement of a change was made, so none was applied.
- MAX_PUSHES stays 64 and MAX_VECTORS is 4. apply_mix is not vectorized, so recipes over 64 neurons are left out of the catalog; their dense siblings are better anyway.
- Field Guide and grown strains stop at 300 tokens (`settings.maxTokens`). Other strains are unchanged.
- Grow walks strengths from the strongest down and stops at the first that holds, instead of the search's whole grid: a rung costs about a minute on 4B.
- Grow adds a check on the first 8 replies: if the description's words show up in under 60%, it writes the named text straight away. Keeps the search's after-the-grid fallback too.
- Grow's verdict compares against unsteered replies scored the same way, because the local judge is rough (AUC about 0.72).
- No extra memory bytes for Grow: 3.44 GB at the peak on 4B against 4.8 GB already counted for a loaded Lab.
- Deep Thoughts is out of the catalog because the flagged no-repeat recipe is the same neuron and dose. Generated catalog drops every Content flags row, death themes, and samples hitting the offensive or leak filters.
- Word lens tables are small (4B 91 KB, LFM3 224 KB, 9B 60 KB), so they ship.

## Numbers
Strain chat path (createApp, sessions.run, harness chat, 4B, 24 replies each, automatic rules, not a human or Opus read):
| Recipe | First 90 words (about 120 tokens) | About 225 words (300 tokens) | Full length | Held-out in the search |
| --- | --- | --- | --- | --- |
| Surprise! L22N4296+0.6, repeat 1.1 | 24 of 24 | 21 of 24 | 20 of 24 | 135 of 144 |
| The Bard (vector, L8 x1.2, no repeat) | 23 of 24 | 22 of 24 | 16 of 24 | 137 of 144 |

Grow on Qwen3.5 4B (the Mac was also running other models and load, up to 15):
| Description | Path | Strength | In character | Unsteered | Time | Peak |
| --- | --- | --- | --- | --- | --- | --- |
| a lighthouse keeper | Lab direct | 1.2 | 21 of 24 | 0 of 8 | 9.2 min | 3.44 GB |
| a very sleepy cat | Lab direct | 0.85 (1.2: 14, 1.0: 16) | 18 of 24 | 0 of 8 | 11.9 min | 3.44 GB |
| a lighthouse keeper | UI, dev backend, sidecar | 1.2 | 21 of 24 | 0 of 8 | 25.7 min at load 15 | 3.44 GB |

Read by me: both are clearly the character. Lighthouse keeper is a bit overcooked at 1.2 ("must first to understand", drifts) and answers from the tower rather than answering. The cat is delightful and a real answer often survives ("The moon, that big round ball hanging in the sky, tugs at the water"). Two of 8 long replies from the keeper loop on the poem and story prompts.
A Compare during the fit took 17.4 s, and the fit carried on after it.

Prepared sets, through find plus the flow's dose 0.8 on 4 prompts: 4 of 12 kept.
Kept: Surprise (L22N4296, 4 of 4), Apologies (L22N4945, 4 of 4, switches to Chinese on some), Envy (L22N9118, 4 of 4), Cooking (L19N3230, 4 of 4).
Dropped: Honesty, Interpretation, Overwhelmed, Robots (0), Paint (1), Trains (2), Prices and Calculation (the word, but the replies break).

## Hurdles
- Strain chats with no seed gave the same reply every time: MLX's generator state is per thread and each request has a new thread, so 24 replies were 6. Fixed with a fresh seed per reply, test added, measured again. Applies to all strain chats, not just new ones.
- Two CSS classes collided: `.grow` was already the sweep's and `.words` a reply's, which stacked reply tokens one per line. Renamed mine (`.grow-job`, `.word-search`).
- `lab.try_dose` is a property. A foreground `cat $UNSET` hung a command once.
- dcg blocks heredocs into python and sometimes times out at load: scripts written with Write and run by path.
- Vite was killed by the 2 h background limit mid-pass and restarted.

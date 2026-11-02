# TODO_28: Vector recipes, Field Guide, Grow a character

Date: 2026-11-02
Session: 679b90d4-75b6-4409-9b29-3ce234a5ffd9 (implementation sub-agent)
Input: research/personas/FINDINGS.md and suite.json (read-only, another agent is still writing there).

## TODO
- [ ] 1. Vector recipes: sidecar, backend, contract, migration, strains, Compare, Sweep, Seeds, History, Trace, undo
- [ ] 2. Strain sessions: thinking off, stop tokens, stored settings, measured through a real chat path
- [ ] 3. Field Guide: re-runnable catalog generation, UI, one click to Compare, one click to strain, download offer
- [ ] 4. Replace the alien: example applies a recipe, real quote, new presets, docs and leftovers
- [ ] 5. Grow a character (generator C) as the box's main path, word search (generator A), progress, cancel, verdict
- [ ] Final: typechecks, tests, vite build, cargo check, live headless pass, re-run catalog, report

## Design decisions
- A mix holds `LabPush | LabVector` in one list. Sidecar: `apply_mix` adds `strength * scale * resid[layer] * u` to down_proj's output at
  every position (`Hook.post`). One list means every tool that takes a mix (Compare, Trace, Probe, seeds, sweep, history) carries a vector
  without a second field to forget, and the compiler flags every place that assumed a neuron.
- `u` travels as base64 float32 (14 KB). By value, no vector table: a result in History can't dangle after a strain is deleted.
- Recipe text shows a vector as `[The Bard L8 x1.2]`, never its numbers. Pasting that text back works if the mix, a strain or the guide has
  a vector of that name; otherwise it says so.
- Strains get `settings_json` (migration 007): temperature, top_p, repeat. New strains keep what they were tested with; old rows get 0.7, 0.95, 1.1.
- `Lab.reply` stays as the research scripts call it (no stops unless asked): another agent still measures through it.


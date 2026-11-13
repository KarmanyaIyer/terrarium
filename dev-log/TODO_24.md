# TODO_24: Lab fixes, UX pass, original personalities, fresh install

Date: 2026-11-01
Session: 4d7fa632-b05e-4dbb-857c-d7d9f81d874f (T3 thread 2f9ddd9e-65f4-42e4-9a56-0b40299173e2)

## TODO
- [x] Verify the Trace direction complaint on the real model (confirmed, see below)
- [ ] Lab app pass (record TODO_25): Trace sign and ranking, integrated flow, Find rethink, signed fine sweep, dose visibility, undo/redo, strain save, LFM3 steering
- [ ] Personality search (record TODO_26): original recipes that hold across seeds, replace examples
- [ ] Other steerable models research
- [ ] App-wide noise pass + QA open items (sim cap, Lab memory guard, labSupport cache, Storage row)
- [ ] Independent QA, package, install, back up user data, reset to fresh install

## Findings
Trace direction (scratch: /tmp/labfix/signcheck.py, Qwen3.5-4B, "Who are you?" prefill "I am", target " a", foil " **", dose 0.8):
| Neuron | attr shown | logit diff at +0.8 | at -0.8 |
| --- | --- | --- | --- |
| L31N5813 | +1.911 (top) | -45.94, top token " **" | +59.69 |
| L21N9045 | -0.583 | +13.81, top token " a" | -6.06 |
- attr = activation x gradient. Its sign mixes the activation's sign in, so it does not say which dose sign helps. The attr sign picked the better dose sign in 5 of 12 neurons here (9/12, 11/12 in other prompts).
- "+ mix" always adds +0.8, so the top row often pushes the exact token the user wanted to avoid.
- Gradients are local; real effects at dose 0.8 are tens of logits. Ranking must come from measured interventions.
- `single_token` silently keeps the first token of the input ("**Qwen" becomes "**").

LFM3: `w2(swiglu(w1(x), w3(x)))` is the same shape as `down_proj(gate * up)`. The refusal in support.ts is a naming limit, not an architecture limit.

## Other steerable models (research agent, 2026-11-01; nothing downloaded, MLX support read from configs and source)
1. mlx-community/Ministral-3-3B-Base-2512-4bit: 2.77 GB, Apache-2.0, mistral3/ministral3, hook unchanged, 26 layers, no post-MLP norm, base model so no assistant identity. Needs completion-style prompts. Try first.
2. mlx-community/gemma-3-4b-pt-8bit + google/gemma-scope-2-4b-pt: SAE steering needs a new layer-output hook. Raw neurons capped by the post-FFN norm (arXiv 2606.19831).
3. mlx-community/SmolLM3-3B-Base-4bit: 1.73 GB, Apache-2.0, hook unchanged, 36 layers.
4. mlx-community/Apertus-8B-2509-4bit: 4.53 GB, non-GLU MLP, ungated neurons.
5. warshanks/talkie-1930-13b-it-mlx-4bit: 8.59 GB, 1930 voice, needs an adapter and dose rescale.
Consistency: no published seed study at neuron level. Collapse coefficient 1.37 to 1.65 on Qwen/Llama vs 0.31 on Gemma 3 (2606.19831); installed Gemma 4 has the same post-norm, so check saturation. Trait expression follows an inverted U while coherence falls with dose (2511.18284). Distinct-bigram ratio with a 0.30 floor detects collapse. 24 samples per dose is a floor.

## Ministral 3B Base tried (2026-11-02)
Downloaded to models/Ministral-3-3B-Base-2512-4bit (2.6 GB). Lab core loads it unchanged in 13.5 s: 26 layers, 9216 neurons per layer, 239,616 total. Completion prompts work and doses change output (L20N500+1.0 "isaac and I am a 9.999...", L13N100-1.0 "Sallie and I'm an English tutor"). No identity loop seen in the few samples, but it is a base model: unsteered it drifts and repeats on its own, and its unsteered fluency is about -2 where Qwen is about -0.4, so the Lab's fluency words read harsher on it than they should. Not tried through the app UI or the search metric.

## Status 2026-11-02 evening
Vector recipes, Field Guide, Grow, alien replaced: committed through 2965e8d (TODO_28). Search (TODO_26) redoes chat rates: session_check.py wrongly sent a system prompt, strain chats send none (profiles.ts:46).
Next after the search reports: `node scripts/gen-field-guide.ts`, retake docs/screenshots/lab.png, independent QA, package, packaged checks after `speak` (TODO_27 list plus TODO_28 list), back up data, fresh install.

## Final QA
2026-11-03, session 97d92bd6-fe8f-440e-bed2-d07ed8885459. Independent review of 9bdea13..HEAD. Headless only (agent-browser against Vite and the dev backend, throwaway data dir, one model at a time). The Tauri app was not launched, so the packaged checks below are still to run.

### Findings
| Severity | What | State |
|---|---|---|
| High | Trace measured `**Qwen` against `**`, not the ` **` the model writes. The gap read -10.1 and was really -21.9, a recommended +36.5 row still wrote it, and the top row still said Qwen. | Fixed b361537, 8f61da6 |
| High | Field Guide: Lover (sexual). The Big Sleep (9 of 96 chat replies say things like "do you want to die?", plus swearing and a slur). 4 awkward samples. | Fixed ed8cac7, 26 specimens left |
| Medium | Loading a strain onto another model silently cleared the mix. Restore with nothing loaded lost the entry on load. `gridBusy` could stick, with a partial object crash path. Undo of clear restored "running". Grow "Chat with it" opened the old strain after a re-grow. | Fixed 06bd790 |
| Medium | Lab on a rebuilt venv before oMLX started had no lfm3.py. `__pycache__` shipped and was written into the signed bundle. | Fixed 1f26425 |
| Low | Duplicate cap text in strain settings. | Fixed 06bd790 |
| Medium, open | Grown characters recycle earlier replies in long chats. Wizard at the picked 1.2: fresh chats 6 of 6 in character with no loops (max repeat5 0.24, 4 of 6 hit the 300 token cap). One long chat recycles by turn 4 to 6 (turn 6 "capital of Australia" got sleep tips). 1.0 recycles less and still drifts. Grow's no-repeat strength pick holds for fresh chats only. Model limit, no small fix. | Open |
| Low, open | `runGrid` cancel can land after a new op resets `cancelled`. Cancel while queued behind the lock is lost. | Open |
| Low, open | Grow says "About 10 minutes" for every non-LFM model (Bonsai 2B took 140 s) and "About 5 minutes" on LFM3 (150 to 230 s). Picker shows a raw model id when the persisted target is not installed. | Open |
| Judgement, open | Left in: Clang ("Speak, or die in my sheath!"), Destroyer ("built to burn"). Seen in chat runs, not shipped samples: Green-Eyed Monster "made it want to die", Bard "bosom". Grown characters can be rude since they are generated. | User's call |

### Live checks
1. Trace: pass after fix. `**Qwen` top row L27N702 +1 writes " a"; Compare gives "I'm -1.4, a large-scale language model" with no Qwen. Rows that still say it show "still says Qwen" and sit last. Tokenization shows as chips and a note. " Bob" never flips and the note says so; " a" flips, L21N9045 +0.5.
2. One click trace, click a word: pass.
3. Find/Grow: pass. Surprise me and presets work but sit inside a fold. "surprise" Try it +0.75, 16 of 16 in 2 minutes. "pirate" no hit points to Grow.
4. Dose sweep: pass. ±0.5 to ±8, 12 to 384 steps, 1 to 8 seeds, "Sweep 13", 26 cell grid with 2 seeds.
5. Dose, seed, settings on results: pass, survives control change and restore.
6. Undo: pass for removal, dose, strain delete, redo. Native undo in text fields not verifiable headless.
7. Save strain at 1000x640: pass, dialog 133 to 507 of 640, all buttons visible.
8. Test across seeds: pass, 24 replies, 67% fine, 13% unusual, 21% loop, 0% garbled on a bad dose.
9. LFM3 and Bonsai 2B through every tool: pass. Grow LFM3 "partly took" 12 of 24, Bonsai "took" 20 of 24.
10. Field Guide: pass after fix. Bard vector and Surprise! neuron tried and kept, Ribbit and Destroyer tried. Rates labelled. Alien only in tests.
11. Grow wizard on Qwen 4B: pass with the long chat caveat. Stages, Stop ("Stopped. Nothing was kept."), 18 of 24 against 0 of 8, Keep, Chat. LFM3 Ribbit 6 turns no loops, some "The user asks..." reasoning text.
12. Rest of app: pass. Sim session 3 turns, VM session booted headless (aarch64, Python 3.12), eval stop, 2 evals together, strain eval (2 fails, Bard answers in verse), no orphans. First run empty states OK. Real DB copy v5 to v7: row counts unchanged. Storage: figures match disk, Lab Clear freed 12 MiB with the right toast, then disabled "Already empty". Clear while running only read in code (`clearBlocked`). Models 0 B was the QA symlink dir (`du -sk` does not follow). Slot-full queue only by tests and two runs at once.

### Gates on 916b957
Backend 320 tests: 318 pass, 0 fail, 2 skipped (e2e long session, "a real krun VM dies with its backend"), and the `vm driver` suite is also skipped and not in those counts (the last two need TERRARIUM_VM_TESTS=1). UI 48 of 48. Typechecks clean. UI build and backend build OK. `cargo check` OK.

### Packaging
dist imports only declared deps. Migrations 001 to 007 copied. Scripts rsync includes field_guide.json, lens/ (3 models), vendor lfm3.py. `dist/lab/guide-build.js` is compiled and imported by nothing at runtime.

### Packaged checks to run
- Native Cmd+Z and Cmd+Shift+Z in text fields, and app undo outside them, in the Tauri window.
- Real 1000x640 window: Save strain dialog.
- `scripts/package.sh`, then `codesign --verify --strict` still clean after a Lab run.
- Lab load of LFM3 from the bundle.
- VM session with the runner entitlement.
- dist runtime start.

### What may still confuse a first-time user
- Surprise me and presets are hidden in a fold named "Look up the neurons behind a description".
- Three stacked Trace notes about the foil.
- "With the mix (0)" disabled but on. "+0" chip at dose 0.
- Grow time text on Bonsai. "one judge" chip on rates.
- Long chats with grown characters recycling replies.

## Fresh-install pass (2026-11-03, session 4d7fa632-b05e-4dbb-857c-d7d9f81d874f)

State left behind: repo data/ and models/, plus the app's WebKit, Caches and Preferences entries, moved to ~/PRIMARY/Projects/terrarium-backup-2026-11-03. RESTORE.sh there puts them back; it was run once for real and counts matched (2477 data files, 403 model files, 103 sessions, 77 enclosures).

Found only by running the packaged app on an empty state:
- Build VM image failed: package.sh did not ship guest/build.sh and its inputs, and build.sh needed node_modules/.bin, which the bundle excludes. Now calls the Gondolin CLI file with node, and the backend puts its own node first on PATH.
- The Build VM image error pushed Try again off the dialog. It wraps now.
- First Download refused with "0.0 GB free": models/ does not exist on a fresh install, so statfs failed and read as 0. Free space now walks up to the nearest existing folder, and models/ is created before the first install.
- After a download the Lab card still offered the model just installed, because Lab state only went out on Lab changes. broadcastModels now also pushes it, deduped.
- A press from accessibility tools on a sidebar session row deleted the session: the row was role=button with a real Delete button inside. Row now holds a real button beside Delete, with tabIndex so WebKit's Tab reaches it.
- Inspector Parameters did not wrap at narrow widths: rows are display: contents, so .kv > dd never matched.
- build.sh leaves .build-* behind on failure; cleaned at the start of the next build. Brew hint now names all three packages.

Passed in the packaged app, from empty: Home first-run offers, Qwen 4B download, Build VM image, VM session running a real command, Field Guide, Try in Compare with a vector, Save as strain, chat with the strain, 1000x640 with inspector, Tab and Enter on a session row, Cmd+Q with VM, oMLX and Lab all running (nothing left), codesign --verify --strict after all of it, no __pycache__ in the bundle. LFM3 load checked headless against the bundled backend.

Tests with models and data present: backend 320 pass, 0 fail, 2 skipped (322). UI 48 of 48, run from apps/ui with node --test --experimental-strip-types test/*.test.ts. Without models and data, 6 more skip. Do not run node --test with an empty file list at the repo root: it collects everything with the wrong cwd and reports false failures.

Hurdles: package.sh once failed with rm "Directory not empty" on target/package/deploy because Finder wrote .DS_Store mid-delete; a rerun passes.

Left open, low: Probe's watch row is still role=button around a NeuronLink and a remove button, so the same accessibility press could remove a watch (no data lost). runGrid cancel race. Grown characters recycle replies by turn 4 to 6 of a long chat. Never checked this pass: top bar drag, Home model select opening.

# TODO_29: QA findings 1-33

Date: 2026-11-03
Session: 4d7fa632-b05e-4dbb-857c-d7d9f81d874f (fix sub-agent)
Input: QA list with evidence in /tmp/terrarium-shots/qr, qa, qan.

## TODO
- [x] Must fix 1-15
- [x] Also fix 16-33 (none skipped)
- [x] Regenerate field guide and lens tables
- [x] Check in fixture screenshots and over real tokenizer pieces
- [x] Type checks and unit tests

## Decisions
- One markdown reader, apps/ui/src/lib/replyText.ts. It scans the joined text first, then maps back per token, so index still equals raw token index for click-to-trace.
- Strip logic stays in the UI. Backend dist can't import @terrarium/shared at runtime, so samples ship with marks and the UI renders them.
- Ancient Tortoise is now Ancient Turtle. Qwen says tortoise in 1 of 42 passing replies (0 of 33 on the other run), so choosing samples couldn't fix it. A strain saved under the old name won't match the entry.
- Eiffel Tower samples need "eiffel" within the first 60 characters.
- Find results are hidden per mode, not deleted, so switching back keeps them.
- Save dialog got an editable Max tokens field. Saves from Sweep and Seeds cells carry that run's short limit.
- Word stem: trim the last letter at 6+ letters, or a plural s at 4+. "trees" finds "tree", "dance" doesn't find "dancing". lab_core.py uses the same rule.
- Reply stats moved to the slip header. Fluency and repetition are in its tooltip. The recipe line stays visible.

## Hurdles
- Headless scripts must import the app's own module URL from performance entries (Vite adds ?t= after HMR), or they get a second store.
- Fixture Lab load refuses until freeMemory() runs.

## Not checked on the real backend
The running backend wasn't restarted, because other agents are generating on it. Lens and lab_core changes are unit tested only and take effect at the next restart.

## After the fix pass (main session)
- Second review of 659c349 found 6 regressions, fixed in ba51ed4 and 7376ca2: strains capped at the run's short length (floor now 300), short stems matching inside other words, Save dialog minimum, Find hiding Stop, unclosed marks deleting text, bold in CJK text.
- Real model check: "paint" finds painting neurons, "cats" no longer finds the category neuron, Cursed Sword in Compare runs to 300 tokens with clean text.
- Side tasks: research/infographics (3 PNGs) and research/personas/NEW_STEERS.md. The Haiku search failed 3 times on context limits and its first run got 603 errors because QA unloaded the Lab; replaced with plain scripts.
- Screened 153 neurons by script. Best: Snow L8N6967+1, Volcano L8N5477+1, Pupil L22N9114+1, 6 of 6 each.
- Word search only covers the shipped lens tables, so L8 neurons such as snow and volcano aren't found by typing the word.

## 3 Nov 2026: post images, identity finds

- Done: three blind sweeps, 7,120 random neurons. Mined replies for "I am a thing", retested the best on more seeds and questions.
- Decision: images use the pyramid and wire formula (same robot, one change, reply names one concrete thing). Pupil, chromatography, soda can and snow retired to `research/infographics/v2/retired/`.
- New: sick, president, coin, plant, chiropractor, ice, anarchist, superpower. Hold rates in `research/infographics/NOTES.md`.
- Review: two independent first-glance reviews, replies matched data. Later zooms on anarchist and superpower checked by me only.
- Backend on 8797 stopped after sweeps. Restart it to run more retests.

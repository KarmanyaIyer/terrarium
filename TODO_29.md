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

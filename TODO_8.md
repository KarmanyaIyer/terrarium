# TODO_8: review 2 UI fixes (findings 4, 7 UI, 8, 9, 13)

Date: 2026-10-29. Session: 59f651a3-cbf9-4ca8-ada8-0f319c6e0343. Owned paths: apps/ui/**, apps/backend/src/harness/**.

## List
- [x] #4 stale transcript after a session finished while another was open
- [x] #7 (UI) network tab: attempts not rows, "latest N", refetch on reconnect, sort by latest attempt
- [x] #8 controls that always fail on eval case sessions (and released eval envs)
- [x] #9 truncation warning: per-call budget, right remedy, thinking tokens
- [x] #13 filler text and silent caps
- [x] Found while verifying: eval case sessions opened from an eval cell showed "Session not found" after any reload

## What changed and why
- **#4** `loadTrace` on an already loaded trace now fetches `after=contiguous` (merge drops duplicates). `fillGap`
  queues a second fetch when one is already in flight instead of dropping the request. Live buffers (model deltas,
  tool output) that missed chunks while unsubscribed or while the socket was down are dropped on rejoin, and a call
  or tool call whose start was not seen live shows a `partial` chip until its final event arrives. Before, new
  deltas were appended to a stale buffer, leaving a silent hole in the middle.
- **#7** Header counts attempts (sum of `repeats`) and denied attempts. When the response length equals the
  requested limit the header shows a `latest N` chip and a `Load 5,000` button (backend max). Resync after a
  reconnect reloads every loaded env's net log. Rows sort by `lastTs ?? ts`; a repeat update moves its row to the
  newest end; the time column shows the latest attempt (title has the first-to-last range).
- **#8** `assertNotEval` callers are `sendMessage` and `continue`. UI: Continue in the truncation box and on
  `run_end`, Raise output cap, Raise context window, Turn off thinking are hidden on eval sessions; the composer was
  already read-only. Also made read-only on eval sessions: model picker, harness picker, thinking switch and the
  header network switch (they PATCHed the session, which rewrote the model/settings an eval cell was graded with).
  Backend: `update()` now calls `assertNotEval` for anything but a title, so the record can't be changed by API
  either. Released eval envs (storage freed after the run) answered 409 to Start, Snapshot, Fork, Reset and
  snapshot Restore; added `released?: boolean` to `EnvSummary` (shared, one line; manager.ts one line, which the
  backend agent's commit 28f222c already includes) and the Environment, Network and Shell tabs hide those
  controls for released envs (Delete stays).
- **#9** Backend `output_truncated` data now has `maxTokens` (this call's budget), `maxOutputTokens` (session cap)
  and `reasoningTokens` (from oMLX usage `completion_tokens_details.reasoning_tokens`, which the gateway already
  parsed: 513 of 514 stored calls have it). Message distinguishes cap vs window. UI: budget < cap means the window
  set the limit: title "Reply cut off: context window full", a "Room left" number, and "Raise context window to
  <next size>" (keeps the output cap; shows a memory fit warning if the model would not fit). Cap-limited replies
  offer "Raise output cap" only when it would actually raise the cap (max window - 1024, the backend's clamp).
  Thinking numbers fall back to the call's own usage for old events. The duplicated prose message line was
  dropped from the box (numbers say the same).
- **#13** Suite description moved from a subtitle to the h1 tooltip; palette no longer cuts at 40 (the list
  scrolls; before, 40+ sessions also hid Environments, Go to and Actions); eval composer shows `eval case`,
  `read-only`, `env released` instead of two sentences. Sweep: RequestTab "Streaming; the transcript shows..." ->
  "Streaming"; EnvTab facts "Not gathered yet; start the environment" -> "Not gathered"; removed "Click to open the
  transcript" from the eval cell tooltip; timeline tooltips: file list capped at 8 now says "N more", tool command
  and user text get an ellipsis when cut.
- **Eval session not found**: `/api/state` lists no ephemeral sessions, so `openSession` on an eval case after a
  reload rendered "Session not found". Added `getSession` (existing `GET /api/sessions/:id`) and fetch on open;
  `hydrate` keeps fetched eval sessions across reconnects.
- Header env button: a long env name (every eval env) overflowed into the model name; it now truncates.

## Tests
- UI `tsc --noEmit` clean, `vite build` OK. Backend `tsc --noEmit` clean.
- Backend harness `node --test src/harness/*.test.ts`: 27/27 (2 new: truncation warning budget cap-vs-window,
  eval sessions reject message/continue/settings PATCH but allow rename). Full suite: 130 tests, 129 pass,
  0 fail, 1 skipped.
- Real UI (Brave via wb) against the dev backend with real data and oMLX + Qwen3.5 4B:
  - #4: opened a 4K chat session A, started a run, switched to B; A finished; back on A the finished call, the
    warning and run_end were there. Second run: left mid-reply, came back mid-reply: call showed `partial` with
    only the new deltas; at the end the final message replaced it.
  - #9: old cap-limited warning: 8,192 / 1,098 / cap 1,024 / 1,024, "Raise output cap to 2,048". New window-limited
    run: "context window full", Room left 370, cap 2,048, thinking 371, offers Continue, Raise context window to
    8K, Turn off thinking. Clicking Raise set the session to 8K with cap 2,048 and the button went away. The
    continued run was cap-limited (2,048, thinking 1,923): "Raise output cap to 4,096", "Turn off thinking".
  - #8: eval case session (sandbox boundary vm-host-services): header model/harness/thinking/network static,
    composer read-only, released env's tabs show only Delete and a static network mode.
  - #7: same eval env: "11 attempts, 11 denied" over 5 rows (x3, x2...). Restarting the backend: after reconnect
    the net log was refetched (2 more /net requests) and the open eval session stayed.
  - #13: injected 60 fake sessions into the in-memory store (client only): palette rendered all 72 rows with a
    scrollbar; Environments, Go to, Actions reachable at the bottom.
  - The QA session I created was deleted afterwards.

## Hurdles
- `node --watch` restarts the dev backend whenever another agent edits backend files, and the dev token changes
  each time; ran `node src/main.ts` with a fixed `TERRARIUM_TOKEN` instead.
- Driving the store from devtools: after HMR the app imports `store.ts?t=<ts>`, so `import('/src/state/store.ts')`
  returns a second, unconnected copy. Use the URL from `performance.getEntriesByType('resource')`.
- dcg blocked a heredoc containing JS template literals; used the Edit tool instead.

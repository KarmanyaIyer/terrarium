# Terrarium UI build

2026-10-28, session 322a59c5-e0d3-4112-a0be-c33f3a3e95bf (design sub-agent, owns apps/ui only)

## Tasks

- [x] Scaffold apps/ui: Vite 8, React 19.3, TS 7, exact pins
- [x] Data layer: typed REST client (every route), WS client (subscribe, reconnect with backoff, ping, resync), zustand store with seq-ordered merge and gap fill
- [x] Connection: fixtures, Tauri `backend_info`, `#url=&token=`, VITE_BACKEND_URL/TOKEN, saved session entry; connect screen otherwise
- [x] Fixture backend: scripted invoice-fix VM run, sim logs run, chat, 6 models, eval runs (one live), resource samples
- [x] Shell: tokens (light/dark), top memory bar + oMLX control, sidebar, Cmd+K palette, toasts
- [x] Session view: header with model/harness/thinking/network controls, live timeline, virtualized transcript, composer with context meter, truncation warning with actions
- [x] Inspector: Files (tree at step, scrubber, file / vs start / this step), Request (readable, raw, SSE), Network, Environment, Shell
- [x] Evals view, Models view, New environment sheet
- [x] tsc + production build clean
- [x] Independent QA pass (Opus, fixture mode, both themes, 1440 and 1100), fix findings
- [x] Final screenshots in apps/ui/screenshots (light + dark)

## QA round 1 findings and fixes

- Suite view white-screened: zustand selector returned a new filtered array each render (infinite loop). Selector now returns the raw list; filtering is memoized.
- New-env sheet created envs on segmented clicks: shared buttons (Segmented, Switch, ConfirmButton, CopyButton, Expander) had no `type="button"` inside a form.
- Diff parser added a bogus trailing row after the last hunk: parser now honors hunk line counts.
- Files scrubber snapped back to Latest after Previous: focusing a step now always pins.
- Env links from Evals/Models went nowhere (no inspector there): openEnv switches to Home there; eval results open the cell's session with Files.
- Stopping oMLX and loading a model that does not fit now confirm inline; composer warns when the session's model will not fit.
- Fixture follow-ups restarted at turn 1 with no history: Script takes turnBase and history rebuilt from the trace.
- Connection badge opened the palette: now a popover (backend, status, restart fixtures, change backend).
- Layout: sessions table drops Harness/Context/Used columns by container width; inspector width keeps the main column at least 480 px; block headers hide whole stats instead of cutting numbers; terminal output no longer wraps; timeline toggle no longer covers the 0s tick.
- Not changed: header Stop stays one click (Esc also stops instantly, per the brief, and a stopped run can Continue).

## Decisions

- Chrome is graphite; color is reserved for data and status. Accent blue means "the agent" (live edge, running, selection).
- Tool colors validated with the dataviz validator; labels inside bars are the secondary encoding. Thinking is striped (texture), prefill is a lighter step of the model hue, generation is solid.
- Timeline folds idle gaps over 12 s to 22 px so long waits do not flatten the busy parts. Fit mode by default, zoom via buttons or Cmd+wheel.
- Memory estimate and fit are computed client-side (weights + ctx x KV/token + fixed + 1 GiB), mirroring DESIGN.md; the contract has no estimate route.
- Restore-from-snapshot uses `resetEnv { snapshotId }`.
- Selecting a tool call anywhere moves the Files scrubber to that call's step; the tab only switches when the selection came from the timeline.
- Inspector hidden on Models and Evals (the matrix needs the width); on Home it shows the first environment.
- New-env facts preview is copied from an existing env of the same type (facts are gathered, never hard-coded prose).
- Own small implementations instead of libraries: ANSI SGR parser, LCS unified diff, JSON tree, markdown via marked's lexer rendered to React elements (no innerHTML).

## Hurdles

- pnpm wrote a `minimumReleaseAgeExclude` into the root pnpm-workspace.yaml for lucide-react 1.63; reverted (not my file) and pinned 1.61.0, which is outside the release-age window.
- HMR of store.ts leaves the app on "Connecting" because of the module-level boot guard; a page reload fixes it (dev only).
- `fmtPct` takes a percentage, not a fraction; eval pass rates showed "1%" until fixed.
- Block headers wrapped at 1100 px; header children are now nowrap with stats/commands as the shrinking item.

## Contract additions (packages/shared/src/index.ts, additive)

UpdateEnvRequest, SnapshotEnvRequest, ForkEnvRequest, ResetEnvRequest, SendMessageRequest, UpdateModelRequest, LoadModelRequest.

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
- [ ] Independent QA pass, fix findings
- [ ] Final screenshots in apps/ui/screenshots (light + dark)

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

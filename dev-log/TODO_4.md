# TODO_4: Tauri app shell and packaging

Date: 2026-10-28
Session: e192100e-fec1-41cd-ba10-27648a664467 (app shell sub-agent; owns src-tauri/**, scripts/, root package.json scripts)

## TODO
- [x] Pin @tauri-apps/cli 2.12.4 (root devDep), tauri =2.12.5, tauri-build =2.7.4 (checked crates.io/npm 2026-10-28; 3.0 is alpha only)
- [x] src-tauri: spawn backend, handshake, backend_info, hide on close, Quit with SIGTERM + 10 s wait, error view, CSP, overlay title bar, menu
- [x] Icon (src-tauri/icons/icon.svg rendered with sips, sizes via `tauri icon`)
- [x] scripts/package.sh: Node 24.22.2 (sha256 pinned), UI + backend build, pnpm deploy (hoisted), tauri build, assemble, sign, install
- [x] Package build + verify (connect, quit stops backend/oMLX/VMs, relaunch, hide on close, error view, screenshot)
- [x] `pnpm tauri dev`
- [x] Commit

## Verification (2026-10-28, isolated data dir)
- Packaged app: window connects to the bundled backend; state from the DB copy shows (envs, session, 6 models).
- Through the app's backend API: oMLX started (no model), a new VM env booted with the bundled krun runner (`uname` = Linux 6.12.68, user agent).
- Cmd+Q (custom menu item): app, backend, sim worker, oMLX and the VM runner all gone within 1 s; VM recorded as stopped.
- `osascript quit app "Terrarium"` (Dock/AppleEvent path): same, within 2 s.
- Relaunch works; Cmd+W hides the window and everything keeps running; `open` (Reopen) shows it again.
- Error view: dataDir under /System -> "Terrarium backend failed" with the EPERM stack; fixing config + "Restart backend" recovers without relaunch.
- `pnpm tauri dev` (reusing the running Vite on 5173): debug shell runs the backend from source, UI connects, Cmd+Q stops it.
- Size: 354 MB (node 117 MB, backend node_modules 225 MB, shell 4.7 MB).
- Not done: launch against the real data/ dir (the integration agent's backend was running on it the whole time). `beforeDevCommand` itself not exercised for the same reason (Vite strictPort 5173 was taken).

## Decisions
- Backend files are copied into the bundle after `tauri build` (not via bundle.resources/externalBin): tauri-build validates those paths on every build, which would break `tauri dev` before packaging, and copying with ditto keeps the krun runner's own signature (hypervisor entitlement) and Node's Developer ID signature. Outer bundle re-signed ad-hoc without --deep.
- Bundle mirrors the repo layout under Contents/Resources/app (apps/backend/{dist,scripts,node_modules}, evals/) because the backend resolves REPO_DIR, eval suites and omlx_serve.py relative to its own files. No backend source changes needed.
- Hardened runtime off for the shell (ad-hoc personal build, no notarization). Node keeps its own hardened signature + entitlements (allow-jit, disable-library-validation).
- Data/models/venv: env TERRARIUM_* > ~/Library/Application Support/Terrarium/config.json (dataDir, modelsDir, venvDir; ~ expanded) > repo paths baked in at build time (CARGO_MANIFEST_DIR/..).
- Backend runs in its own process group. Quit: hide window, SIGTERM + close stdin, wait up to 10 s, then SIGKILL the group (also kills anything it left behind).
- Custom Quit menu item (Cmd+Q) instead of the predefined one, so quitting always goes through the graceful path. RunEvent::Exit also calls stop as a backstop.
- Debug builds (`tauri dev`) run the backend from source (`node apps/backend/src/main.ts`, node from PATH) unless TERRARIUM_BACKEND_URL/TOKEN are set.
- Traffic-light inset: the UI's top bar already has data-tauri-drag-region; the shell injects `.topbar{padding-left:80px}` from src-tauri/src/shell.js, so apps/ui is untouched.
- Backend stderr goes to ~/Library/Logs/Terrarium/backend.log (previous run kept as backend.prev.log) in the packaged app.

## Hurdles
- `strip = true` in the release profile made every stripped proc-macro dylib unloadable (`dyld: mis-aligned LINKEDIT string pool`, surfacing as rustc E0463 "can't find crate"). Strip is off for release and build-override.
- The integration agent runs a backend on data/ during this work. Backend startup resets running sessions/envs/eval runs, so verification uses an isolated data dir (/tmp/terrarium-verify-data: online sqlite backup of the real DB + blobs copy + images symlink) via config.json.

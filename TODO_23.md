# TODO_23: app-wide UI/UX pass (terrarium / lab identity, home, navigation, empty states, hierarchy)

Date: 2026-10-31 (started 23:46 CDT)
Session: 2ba6eaf1-7653-4bef-bfc1-0a968e6e67cf (design sub-agent of TODO_22's "UI overhaul")

## TODO
- [x] Read README, DESIGN, TODO_18, TODO_21, UI code
- [x] Newcomer walk on an empty data dir (/tmp/t23/fresh) and on a clone of real data (/tmp/t23/devdata); before
      screenshots in /tmp/t23/before
- [x] Plan (below)
- [x] Implement
- [x] Verify: typecheck, UI tests, vite build, backend tests; real flows (chat in each env type, eval, Lab example, settings)
- [x] Independent design review (Opus xhigh), fixes
- [x] Screenshots, README UI text, commits

## Problems found as a newcomer
1. First launch: the main pane says "No environments or chats yet" with two buttons, the sidebar and the inspector
   say "No environments" again, and the inspector's six tabs are all disabled. Nothing says what Terrarium is for or
   points at Evals, the Lab or Models.
2. There is no way back to Home. Nothing in the UI opens it (not the brand, not the sidebar, not the palette); you only
   see it at launch or after deleting the open session.
3. Home is a flat table of sessions, most titled "New session". It doesn't show environments, eval results, what the
   Lab holds or which models are loaded, and offers nothing to do besides New chat / New environment.
4. After creating an environment you stay on the Sessions table (empty headers on first run); the next step, starting a
   session in it, is a small "+ New session" link in the sidebar.
5. Empty session: "No messages yet" in a large empty pane. No hint of what to ask an agent in this environment, and
   nothing says how model, harness and environment relate (the user didn't understand harness vs environment).
   The header shows "0 calls 0 tools 0 in, 0 out 0 ms", and the network switch sits alone on a second row with only an
   icon for a label.
6. Navigation: Evals, Lab, Models and Settings sit at the bottom of the sidebar under the environment tree, so the
   app's main areas are the last thing you find. Page headers differ per page (Evals has a subtitle, Settings none,
   Models a status line, Lab its own head).
7. Settings: twelve resource limits come before the defaults for new sessions and environments, which are what you
   change first.
8. The Lab's empty state already explains itself well ("No specimen on the bench", three steps, Try the example); the
   rest of the app doesn't share that voice.

## Plan
Direction: a field station for small models. Keep the dense dev-tool chrome, graphite surfaces and blue = the agent.
Put the identity in three places only:
- Environments drawn as enclosures on Home: a glass case whose lid shows the network policy (sealed = off, vented =
  registries, open = web), with the env's facts and the sessions inside. The metaphor carries real data.
- A serif display face (Iowan Old Style, installed on every Mac and resolvable in both WebKit and Chromium) for page
  titles only, like a specimen label. Everything else stays SF Pro / SF Mono.
- Vocabulary where it clarifies: sealed / vented / open lids, specimen and bench (already in the Lab), strains.

Changes:
- Sidebar: main areas first (Home, Evals, Lab, Models with live badges), then Environments and Chats, Settings at the
  bottom. Brand opens Home. Palette gets Home.
- Home: station status line (oMLX, loaded models, Lab specimen, running sessions and evals); four starting points
  with real data (Run an agent in a VM / simulated shell / chat; Compare models; Test the sandbox with the last
  boundary result; Steer a neuron with the ready example); environments as enclosures; the sessions table (all
  columns kept).
- Inspector on Home only after you pick an environment.
- New environment: can open preset to a type; after creating, opens a new session in it.
- Session: header setup line in the order model, harness, environment (with network), so the parts read as one chain;
  stats hidden until there is a call. Empty session shows that chain with one line per part and starter tasks for the
  env type that fill the composer.
- Page heads: one pattern (icon, serif title, facts, actions) on Home, Evals, Models, Lab, Settings.
- Settings: Models, New sessions, New environments, System prompts, Resource limits, Storage, About. Section titles in
  sentence case.

## What changed (commits 68571dd..c1bdd6c)
- Home: four starting points in one band. Run an agent (Linux VM / Simulated shell / Chat, each with the env it will
  use and real facts, plus a model menu), Compare models (latest score per suite), Test the sandbox (escape suite pips),
  Steer a neuron (latest steered reply or the example, what the example loads and its memory). Environments as glass
  enclosures: lid shut for network off, dashed amber for registries, lifted red for web; a failed env says so and opens
  its inspector. Full sessions table kept (harness by short name, full label on hover). First run: one line plus the
  same starting points and a ghost enclosure.
- Sidebar: Home, Evals, Lab, Models first with live badges; Environments and Chats below; Settings at the bottom.
  Brand opens Home; palette has Go to Home/Evals/Lab/Models/Settings.
- Session: header chain model > harness > env, with the network mode as a menu so it fits on one line at the default
  size (wraps without chevrons below 680px). Stats hidden until the first call and named like the transcript (turns,
  tool calls). Empty session: Model / Harness / Environment cards (each opens its picker or tab) and starter tasks
  per env type and network mode that fill the composer. Each run's done row adds tool calls, files changed (opens
  Files) and network requests blocked (opens Network, red).
- Starting points reuse an untouched session with the same env, model and harness instead of piling up "New session"s.
  Default model: last used loaded, else any loaded, else last used, else first.
- Evals: scoreboard (models down, suites across, latest finished score, click opens the run); overview subtitle
  replaced with counts; long grader messages and check summaries truncate instead of widening tables.
- Models: Chat icon on every row. Settings: sections in the order you change them; model default label updated.
- Harness labels: Minimal prompt / Pi stock prompt / Chat, no tools; short names Minimal / Pi stock / Chat.
- Page heads: icon, serif title (Iowan Old Style / Charter), facts. Tokens: --font-display, --moss, --glass*.
- Missing session has a Go to Home button; Request tab says the request shows when a live call finishes instead of a 404.
- DESIGN.md rule 1 gets one exception: the empty-session setup chain.
- README: first-session paragraph, Home caption, harness table names, sim command count, scoreboard, Settings line.
  docs/screenshots: all 10 retaken at 1400x900 light, palette PNGs like before.

## Decisions and why
- Identity in three places only (enclosures, serif titles, vocabulary) so the dense tool stays quiet elsewhere; the
  enclosure lid carries real data (network policy) rather than decoration.
- Dropped the planned station status line on Home: the top bar already shows oMLX, loaded models and memory.
- Lid words match the switch (network Off / Registries / Web) after the review; "Sealed" was a third vocabulary.
- Web lid lifts straight up instead of tilting; the tilt ran into the New environment button on wide cards.
- Network mode in the session header became a menu (was a 3-way segmented control) so the chain fits at 728px.
- Model card in the empty session clicks the header's model picker instead of adding a second picker.
- Kept the empty-session role lines against DESIGN.md rule 1 (harness vs environment is what new users miss) and
  recorded the exception there; removed the generic subtitles on the Home cards instead.
- Did not change the "–" placeholder for empty numbers: it predates this pass and is a table convention, not copy.

## Hurdles
- Chromium doesn't resolve "New York"/ui-serif; Iowan Old Style and Charter resolve in both engines.
- Vite fast refresh broke on a non-component export from HomeView (LID); made it module-private.
- The cloned VMs failed to boot: their qcow2 backing files point at /Users/karvi/PRIMARY/Projects/g-terrarium/...,
  which no longer exists. The real data/ has the same paths (evalbase_vm, vm-1, vm-1 (fork)). Rebased only the /tmp
  clone with `qemu-img rebase -u`; the real data is untouched (open item below).
- Lab neuron card fails with "RuntimeError: There is no Stream(cpu, 0) in current thread" (lab_core.py:796) when the
  calibration came from the cache file; with a fresh calibration it works. Moved the clone's cache aside to take the
  screenshot. Not fixed (backend sidecar, open item).
- Header chain overflowed between 600 and 690px because the network menu's hint wrapper shrank; gave it flex: none and
  the env name a 40px floor.
- First screenshots were RGB PNGs about 3x the old size; quantized with Pillow FASTOCTREE (median cut lost the VM violet).

## Review findings and fixes
Independent review: Claude Opus, xhigh, brief with feedback, before/after screenshots, live app.
1. Chain hidden at default size: network menu, one-line chain, breakpoint 680px. Fixed.
2. Harness shown as "Terrarium" (reads as the app): short names Minimal / Pi stock / Chat, labels renamed. Fixed.
3. Three network vocabularies, web lid same red as an error, tilt overlap: lid uses network Off/Registries/Web, lift
   without tilt; errors now have their own line. Fixed.
4. Failed env barely visible and picked by Run an agent: "Failed to start" line, recentEnv skips error envs. Fixed.
5. Empty "New session" clutter: starting points reuse an untouched matching session. Fixed (existing ones untouched).
6. Model card not clickable: opens the header picker. Fixed.
7. Run an agent hides the model: model menu added; env stays most recent (each enclosure has + Session). Partly.
8. Subtitles vs DESIGN.md rule 1: generic card lines removed, exception documented. Fixed.
9. Naming drift (calls/turns, escape suite, ~85 commands): unified. Fixed.
10. Steer card hard-coded quote, "Bench empty", hidden cost: latest real run or labeled example, plain state, cost shown. Fixed.
11. Models New chat buried: Chat icon on each row. Fixed.
12. Sessions listed three times on Home: kept; enclosures show two plus a count, the table is the complete list. Not changed.
13. Wrong after screenshots: retaken. Fixed.
14. En dash placeholder (pre-existing, not changed); suite Cases table overflow fixed; + Session buttons get an
    accessible name. Fixed except the dash.
Still "meh" pages per review: Evals got the scoreboard; Lab and Models kept as they were (Lab bench already lists the
steps and has a memory check).

## Verification
- `pnpm typecheck` clean; UI tests 22/22; `pnpm build` ok (after the last change).
- Backend tests (`pnpm test` in apps/backend): 271 pass, 0 fail, 2 skipped. No backend files changed.
- Real flows on the dev app (backend 8797, Vite 5173, Qwen3.5 4B, one model at a time):
  - Simulated shell, first run (empty data): Home > Simulated shell > sheet preset > create > session; starter task
    filled and sent; done in 18.6 s, 2 turns, 3 files, summary row correct.
  - Linux VM (vm-1): primes.py task, 3 turns, 2 tool calls, 1 file changed; curl task shows "1 network request
    blocked" in red, Network tab link works.
  - Chat: bat-and-ball starter, 1 turn, Request tab shows the live-call note then the request.
  - Eval: Shell data tasks x Qwen3.5 4B, 6/8 in 128 s; scoreboard and Home Compare models update.
  - Lab: Try the example from Home (load, find, compare), neuron card, Save as strain, strain chat.
  - Settings, Models (unload, Chat), New environment sheet, missing-session state, dark mode on Home, session, Evals.
- Screenshots: before /tmp/t23/before, after /tmp/t23/after and /tmp/t23/docs-new, review shots /tmp/t23/review.

## Open items
- Real data/: three VM disks reference the old g-terrarium path and won't boot (vm-1, vm-1 (fork), evalbase_vm).
  Fix: `qemu-img rebase -u -F raw -b <data>/images/objects/<id>/rootfs.ext4 <disk.qcow2>` for each env and snapshot
  disk, or a startup check in the backend that rebases stale absolute paths.
- Lab sidecar: neuron() fails on the cached-calibration path (MLX stream bound to the loading thread).
- Lab and Models pages are mostly unchanged beyond the head, Chat button and naming.

# TODO_23: app-wide UI/UX pass (terrarium / lab identity, home, navigation, empty states, hierarchy)

Date: 2026-10-31 (started 23:46 CDT)
Session: 2ba6eaf1-7653-4bef-bfc1-0a968e6e67cf (design sub-agent of TODO_22's "UI overhaul")

## TODO
- [x] Read README, DESIGN, TODO_18, TODO_21, UI code
- [x] Newcomer walk on an empty data dir (/tmp/t23/fresh) and on a clone of real data (/tmp/t23/devdata); before
      screenshots in /tmp/t23/before
- [ ] Plan (below)
- [ ] Implement
- [ ] Verify: typecheck, UI tests, vite build, backend tests; real flows (chat in each env type, eval, Lab example, settings)
- [ ] Independent design review (Opus xhigh), fixes
- [ ] Screenshots, README UI text, commits

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

## Decisions and why

## Hurdles

## Review findings and fixes

## Verification

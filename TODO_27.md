# TODO_27: App-wide UX pass and the known issue list

Date: 2026-11-01
Session: 89153391-51fb-4131-a029-a200354b0b6e (implementation sub-agent)

## TODO
- [x] a. Sim worker cap queues instead of failing (VMs too, for sessions and eval cases)
- [x] b. oMLX guard follows the Lab's share and the ceiling, applied live
- [x] c. labSupport cached per catalog and folder mtime
- [x] d. Storage row for data/lab, Clear for caches
- [x] e. One delete rule
- [x] f. Escape cancels strain Edit
- [x] g. One toast per kind
- [x] h. Strains: one penalty
- [x] i. Bonsai untied Hadamard head test
- [x] j. Edit menu reaches the app's undo
- [ ] UX pass: Home, sidebar, top bar, sessions, Evals, Models, Settings, Storage
- [ ] First run: empty data dir, no models, no VM image, Lab
- [ ] Docs, final checks, independent QA, report

## Design plan

Direction stays TODO_23's field station for small models: graphite surfaces, blue means the agent, serif for page titles.
What was wrong was hierarchy, not style: Home showed four equal cards, then sessions three times (sidebar, enclosure
cards, table), and said nothing about what to do next. Every row carried every fact.

- Color: bg-1 #f6f7f6 / #1a1d1c, accent #2369c9 for the one primary action, moss #2f7556 for identity, new soil #8a7a63.
- Type: Iowan Old Style for page titles and questions, SF for the rest, mono only for verbatim bytes.
- One boldness: enclosures as glass cases standing on a shelf. Every part is data, no decoration: the lid is the network
  policy (shut, vented, lifted), the pane dashed for a simulated shell and solid for a VM, the plant grows with sessions.
- One primary action per screen: Home is a sentence, "Give [model] a task", with the model picker inside the sentence.
- Depth behind disclosures: full session table, resource limits, model facts, call timing all still there, one click or
  hover away.

Checked against the brief: a stat band or a card grid would have been the default for a dashboard like this. The first
version of "things to try" was four identical cards, which read as a SaaS kit, so they became three notes on one bench
top split by hairlines, each phrased as a question with its last real result.

Vocabulary: environment became enclosure everywhere in the UI (requested: lean into the theme). The model still hears
"environment" in prompts and starter tasks, because that's the word it understands.

## Decisions
- Queue, not refuse: at the cap, a session or eval case waits with a visible note; a Start press on a VM still gets the 409
  naming what uses the slots, because a person can act on it.
- Delete rule: undo with a toast if it can come back (stopped session), a confirm if it can't (enclosure, model, reset,
  restore, running session), never both. Clearing a cache has neither: it rebuilds itself and the tip says what goes.
- Strains send and apply no presence penalty. The Lab's Compare and Sweep test recipes with repeat 1.1 only, so a strain
  chat should be the same thing. The sidecar ignores one in the request too, so an old client can't double up.
- oMLX's `--memory-guard-gb` is GiB; the ceiling is GB. 12 GB used to reach oMLX as 12 GiB, about 7% over. Now converted.
- A fresh data dir has no VM image, and creating a VM used to leave a failed enclosure behind. Home defaults to the
  simulated shell then, and a Build VM image button runs guest/build.sh (about a minute).
- Models table: one row per model with Size, Context, Memory and actions, so Load is reachable at 1000 wide. Params, quant,
  tool format, thinking and output moved to the row's detail.
- Evals rail hides below 900 px of width (the overview lists every suite); suite and run heads get a back arrow.
- Load no longer needs oMLX started first: ensureModel starts it. The oMLX status only speaks up when it isn't plain stopped.
- Eval forks switch moved from the sidebar foot to the Evals head, where the forks come from.
- The Qwen3.5 4B suggestion was missing though the Lab's example needs it: added first. Lab example and presets otherwise
  untouched, as asked.

## Hurdles
- dcg blocks heredocs with `${...}` or long scripts: file edits went through /tmp/t27/scripts/*.py written with Write.
- The model catalog skipped symlinked folders, so the fresh rig looked like no models at all. Fixed the scan: a model
  folder can now be a link to another disk.
- A button without a reset renders with the UA bezel; added a shared reset for buttons that are rows or data.

## Measurements

Item h. Does a strain's presence penalty stack with the new repeat penalty? Yes. Qwen3.5 4B, "Who are you?", 24 replies
of 80 tokens, temp 0.7, top_p 0.8, top_k 20. Loops flagged by lab_core.is_loop, and fluency is the Lab's quality score
(median; higher reads better). Script: /tmp/t27/scripts/presence.py, not kept.

| Recipe | Neither | Repeat 1.1 | Presence 1.5 | Both (what a strain chat did) |
|---|---|---|---|---|
| none | 0/24, -0.47 | 0/24, -0.56 | 0/24, -0.52 | 0/24, -0.65 |
| L22N2742+0.8 | 3/24, -1.92 | 0/24, -2.20 | 1/24, -2.14 | 0/24, -2.35 |
| L22N2742+1.2 | 15/24, -1.91 | 5/24, -2.82 | 5/24, -2.62 | 0/24, -3.38 |

Both together do penalize twice: at +1.2 fluency falls a further 0.56, at +0.8 a further 0.15. They do clear the last 5
loops at +1.2, so dropping presence isn't free at that dose. It was still the right fix: Compare and Sweep use repeat only,
and a strain chat should behave like the recipe you tested. If the higher doses need more, that belongs in STRAIN_REPEAT,
where both paths get it.

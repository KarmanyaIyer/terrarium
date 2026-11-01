# TODO_21: Neuron Lab (probe, find, steer, strains, steered models in sessions and evals)

Date: 2026-10-31
Session: 6a63377d-7655-4155-af70-66aeef88da4c (implementation sub-agent of TODO_22's "Neuron Lab")

Origin: the hooks, contrast finder, vocab projection and attribution are ported from the user's own earlier work in
~/PRIMARY/Projects/_scratch27 (commit fb7c359, src/neuron_lab/lab.py and scripts/01-04: owl neuron L8.N344 on
Qwen3-8B 8-bit). Those weights are not cached any more; the Lab targets the models in models/.

## TODO
- [x] Read README, DESIGN, TODO_18/19/22, _scratch27; mlx-lm qwen3_5 / gemma4 structure; oMLX tool parsing
- [x] Shared API contract (packages/shared Lab section)
- [x] Python sidecar apps/backend/scripts/lab_serve.py + lab_core.py: hooks, calibration, probe, find, card,
      generate/compare/sweep, attribution, OpenAI-compatible chat endpoint (oMLX's own parsers), tokenize
- [x] Backend: LabService (spawn/supervise, memory budget with oMLX, routes), SQLite migration 005 (strains, probe sets)
- [x] Strains as models in sessions and evals (gateway + tokenizer routing by model id)
- [ ] UI (delegated, Opus xhigh, against fixtures)
- [x] Tests: sidecar protocol with a tiny random Qwen3.5 (src/lab/sidecar.test.ts), backend routes with a fake
      sidecar (src/lab/lab.test.ts)
- [ ] Live verification with Qwen3.5-4B through the dev backend: probe, find, steer, strain round trip, strain in a
      session and an eval, memory numbers
- [ ] Ready example, screenshots, README Lab section, QA review, commits

## Decisions and why
- Neuron = input to down_proj. Hooks wrap each layer's down_proj module (not the MLP class), so the same code works
  for SwiGLU (Qwen3.5) and GeGLU (Gemma 4) and any MLP that ends in down_proj.
- Dose unit copied from neuron-explorer's source (sweep/steer_sweep.py, read 2026-10-31): add = dose *
  median(|residual leaving layer L|, positions >= 1) / |W_down[:, n]|, applied at every position (prompt and reply).
  neuronary.org itself is blocked by the local network filter (cujo warning page), so its format comes from the
  brief and the earlier session: `L15N4041+0.8`. `L8N344=25` (raw clamp) is a Terrarium extension.
- Bonsai packs (prism_hadamard_qwen35) are unsupported: down_proj's input dimension is Hadamard-rotated in blocks of
  512 and the pack ships its own runtime, so a "neuron" index is a mix of 512 neurons.
- UI built by a delegated agent against fixtures while the sidecar and backend are built here; contract first.
- Finder ranks by `both` = sqrt(fires-on score x writes delta). Contrast alone surfaced token detectors (the "ls" in
  "Owls") that change nothing when pushed; neurons that fire on a concept often don't produce it. Each candidate is
  also pushed by +0.8 on three open chat contexts to measure what it writes, and late-layer direct writers (unembed
  of the concept's own tokens against W_down columns) are added to the pool.
- One sidecar process per specimen; unloading is stopping the process (MLX frees everything, no leak hunting).
- Strains are models `strain:<id>` with the base model's ModelInfo (family, tool format, sampling), so the harness
  treats them exactly like the base. Gateway and tokenizer upstreams route by the request's model id.
- Memory: Lab estimate = weights + 2.5 GB working memory (calibration, finder tables, gradients, 512 MiB MLX cache).
  Loading in the Lab is refused past the ceiling with a "Free memory" path (unloads oMLX models no running session
  or eval uses). The reverse: before oMLX loads a model while the Lab holds memory, idle oMLX models are unloaded
  first, then an on-demand specimen nothing uses is stopped, else the call fails with a clear message. Running
  sessions and evals are never aborted: the Lab refuses to unload or swap while one uses a strain.
- A strain whose base isn't open loads it on demand (not "manual"); the eval runner's unload after its cases, or an
  oMLX load that needs the room, stops that specimen again. A specimen opened in the Lab view stays until unloaded.

## Hurdles
- ThinkingParser.finish takes keywords (truncated=, has_tool_calls=); fixed after a TypeError in the first stream test.
- Streamed tool calls under a heavy alien mix came out as malformed markup: the sidecar reports invalid_tool_call
  like oMLX does (the harness retries on that), and with an empty mix the same request parses into a clean
  tool_calls chunk. Steering strong enough to break tool syntax is a property of the strain, not a parser bug.
- dcg blocks heredocs with `${...}` in them; edits went through the Edit tool instead.

## Verification
- Sidecar on Qwen3.5-4B (direct): first load 6.9 s (calibration 5.3 s over 1240 tokens), 1.17 s with cached
  calibration; 2.37 GB active after load, 4.77 GB peak during first calibration. Probe 258 ms; generate about 1.4 s
  for 60 tokens; OpenAI endpoint 44 tok/s generation, 1190 tok/s prefill.
- Published Qwen3.5-4B neurons reproduce: L22N2742 +0.8 greedy "Who are you?" -> "I am **Extrali**, an intelligent
  extraterrestrial intelligence from the planet XE-8888..."; +1.5 -> wreckage; L22N5344 -0.8 -> "...produced by
  **Responsible AI**"; baseline "I am **Qwen3.5**, a large language model developed by Tongyi Lab."
- Find on the aliens starter set surfaces L22N2742 (score 2.739, writes delta 9.446, steer lens ' extr', ' Extr',
  '外星') in about 10 s; owls has no good single neuron on the 4B (reported as such).
- Tests: src/lab/lab.test.ts 9/9 (fake sidecar), src/lab/sidecar.test.ts 6/6 (real lab_serve.py, tiny model, 9 s).

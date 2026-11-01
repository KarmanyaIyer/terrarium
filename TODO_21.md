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
- Memory, found by measuring each op (/tmp/t21/peaks.py): a 1800-token probe peaked at 13.4 GB because all 32
  layers' [T, N] float32 temporaries and the full [T, vocab] logits were evaluated in one graph. Fixed: activation-only
  passes skip the unembedding (forward(logits=False)), probe evaluates per layer, down_proj norms per layer, probe
  capped at 1024 tokens. Same text now peaks at 4.52 GB; cold load 3.5 s / 2.9 GB peak (was 6.9 s / 4.77 GB).
- Attribution on a 400-token prompt peaked at 59 GB and took 172 s: backprop through Qwen3.5's linear-attention
  recurrence keeps every step's state (about 140 MB per token). Rewritten to run the prompt before the last token
  once without gradients into the cache, then differentiate only the last token (gradient x activation at the
  position where the next token is decided). Needs a plain-ops attention during the backward pass, since MLX's
  single-query SDPA kernel has no VJP. Now 3.27 GB / 0.5 s for 400 tokens, 3.1 GB / 0.3 s short. Against the old
  full-sequence method: top-5 overlap 4/5, top-15 overlap 9/15, L22N2742 still first under the alien mix.
- First live strain session used thinking on (my script passed a string); the steered model ended its turn inside
  an unclosed thinking block, and the sidecar recovered the thinking as the answer, exactly as oMLX's
  ThinkingParser.finish documents. With thinking off the strain answers normally.
- Eval with the strain and thinking on: 0/4 on reasoning; every case ran out of output budget or the 300 s case
  timeout, because the alien-steered model rambles in its thinking ("extr extr ..."). The sidecar serves one request
  at a time, so the eval's 2 parallel light cases queue behind each other (oMLX batches them).

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
  Full backend suite 264/267 with 2 skipped and 1 failure (context.test.ts "tool output too big", a sim timing
  test) that passes alone 11/11; it ran while the 4B memory script loaded the GPU.
- Peaks per op after the memory fixes, Qwen3.5-4B (MLX active memory, weights 2.38 GB): cold load 2.9 GB (3.5 s),
  probe 2.63, probe of 1800 tokens 4.52, find 2.74 (15 s, 294,912 neurons, 24 texts), neuron card 2.64, generate
  2.87, attribution 3.13 (0.3 s), attribution of 400 tokens 3.28 (0.5 s). MLX cache stays under 0.6 GB.
- Live through the dev backend (port 8797, /tmp/t21/live.mjs, results in /tmp/t21/live*.json):
  support: Qwen 4B/9B and Gemma 4 supported, the three Bonsai packs refused with the Hadamard reason. Load 4.6 s
  (process RSS 2.83 GB). Chat probe with reply 1.1 s (56 tokens, template/text/reply kinds). Find on Aliens 15.2 s:
  L22N2742 first (both 5.087, writes delta 9.446, lens ' extr' ' Extr' '外星', preview "I am **Extrali**, an
  intelligent extraterrestrial intelligence..."), L7N8842 second (lens '星' '星际' ' spacecraft'). Card: promotes
  ' alien' ' aliens' '外星' ' extr' ' planet', dose unit 60.2. Compare (seed 7, greedy) 3.3 s: steered "I am
  **Extrali**..." vs baseline "I am **Qwen3.5**, a large language model developed by Tongyi Lab..."; fluency -2.05 vs
  -0.17. Sweep 0 / 0.4 / 0.8 / 1.2 / 1.6 / 2.4: Qwen3.5, Qwen3, Extrali, Extraliens, "Iextr Extr Extr" (repetition
  0.92), "aliens extr extr" (0.95). Attribution 0.27 s, L22N2742 first. Strain round trip: saved recipe
  "L22N2742+0.8", parsed by the UI's lib/recipe.ts, re-saved: identical pushes and recipe.
- Strain in a chat session (thinking off): "I am an intelligent extraterrestrial lifeform from the planet Napa, a planet
  in the OTR-1930 system. I have traveled to Earth for over 500 years..." (44 tok/s, ttft 477 ms) while the base
  model in oMLX answered "I am Qwen3.5, a large language model developed by Alibaba Cloud's Tongyi Lab...". Lab
  unload during the session: 409 "The Lab's model is serving strains for session ...". Both copies resident at once
  (Lab 4.8 GB estimate + oMLX 2.7 GB) under the 12 GB ceiling.
- Strain in evals (reasoning, first 4 cases, strain and base in one run): thinking on, base 4/4, strain 0/4 (output
  budget or 300 s timeout, rambling in thinking); thinking off, base 0/4, strain 0/4 (e.g. discount-tax: base 67.5,
  strain 720.56, expected 75). The Lab copy was loaded on demand for the strain's cases and stopped when the eval
  moved on to the base model.
- Memory refusal live: Gemma 4 in the Lab during that eval: 409 "Not enough memory for Gemma 4 12B: it needs about
  10.1 GB and oMLX holds 2.7 GB of the 12.0 GB memory ceiling. In use: Qwen3.5-4B-MLX-4bit (session ...)".
- Gemma 4 12B (direct): loads in 11.7 s, 6.72 GB active, 48 layers x 15360 GeGLU neurons, sliding/full kinds.
  Probe, find (38 s), steer and attribution (1.35 s, 8.43 GB peak) all run; a 1000-token probe peaks at 9.69 GB, which
  set the estimate's 4 bytes per neuron-token (11.3 GB for Gemma). The Aliens and Pirates sets found nothing clean
  (best both 2.2 and 2.8, previews unchanged or broken into channel tokens), so Gemma has no ready example.

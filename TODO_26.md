# TODO_26: Original neuron-steering personalities that hold across seeds

Date: 2026-11-01
Session: 534b2c2f-6f3d-4b86-aea2-76d2c913cc96 (research sub-agent of TODO_24, T3 thread 2f9ddd9e-65f4-42e4-9a56-0b40299173e2)

Work lives in research/personas/. Metric fixed before searching: research/personas/METRIC.md.

## TODO
- [x] Snapshot lab_core, fix the metric
- [x] Check what is already public (see "Already public")
- [ ] Harness: batched sampling, residual capture, cheap filter
- [ ] Methods: lens scan, persona contrast, sparse decomposition, gradient, reply-only, style, evolutionary
- [ ] Held-out evaluation of finalists, judged by reading
- [ ] Top method on 9B and LFM3
- [ ] FINDINGS.md, suite.json

## Already public (checked 2026-11-01)
- justinrhowell/neuron-steering preset for the 4B (hedwigai's set): hostile L14N8949, flatterer L20N7450-, contempt
  L17N8623, poet L17N7426, upbeat L5N8348-, suspicious L5N6573, condescending L11N6819, wistful L5N8940-, oracle
  L5N4530-, bleak L11N2930, dismissive L6N6424-, ornate L15N9125, curt L5N7656-.
- dahara1/EvilQwen-control-vectors: evil L14N8949+ L13N7956-, alien L22N2742+0.8, golden gate L6N7448- L5N6203- L25N8324-,
  anime girl L13N4810+0.8. lyra's neuron-explorer tool (source of the dose unit). occcat/qwen35-evil-neuron: L16N8927.
- shmulc substack (2026-10-29): kosher L20N6937, rabbi L6N7629, genesis L7N916, messiah L7N7017, yom kippur L8N8896,
  language L11N746, Hebrew and German directions, Bibi, Rabin. lysandre/qwen3.5-4b-steering-allcaps: all caps.
- ModelFarm: Extrali (alien), Arnold, on Qwen2.5. Owl L8N344 on Qwen3-8B (Sauers).
- None of these report rates across many seeds; EvilQwen's card says seed 1 hostile, seed 2 normal at scale 0.7.

## Method log
- Harness (plab.py): one prompt, many rows sampled in parallel, a different mix per row. 222 tok/s at B=24 vs 33 tok/s for
  a single row; 4.66 GB peak at B=24. Search uses it; held-out uses the stock Lab.reply path.
- Plain persona contrast (mean residual, system-prompted persona vs neutral), dense at L8/14/20/26: gives a generic archaic
  roleplay voice ("thou art", "those heathen wretch's"), not the theme. Dragon word hits at most 3/16. Breaks by strength 1.0.
- Gradient vector (make the unprompted model imitate persona text, CE on 10-token windows, norm ball): dragon at L14,
  |u| = 0.6 of median residual, gives fluent in-character text with repetition near 0 ("my ancient, scaled form coiling
  around a pillar of obsidian"). Factual prompts resist at this strength. Peak 3.2 GB, 5 s per step while contrast also ran.
- OMP of that vector over down_proj columns fails at low k: cosine 0.21 (k=8), 0.36 (k=32), 0.60 (k=128); no theme words at
  k <= 128 on selection prompts. The dense vector is not aligned with single neurons.
- Growing neurons directly against the loss (gd_sparse.py, 3 layers, k=8 and 32): fluent style drift, 0 to 4% dragon words.
- T3 restart killed background Bash jobs at 16:20. Now detached lanes (runq.py, nohup) reading .cache/queue/*.txt, each job resume-safe.
- L24N3521 fine grid: fluent to +0.4, animal words appear at +0.4 to +0.5 ("large forecasting and reasoning antilope", "a large
  mammal of the class of the rabbit", "Cows are mammals"), collapse from +0.65 (rep 0.40, emoji and ** wreckage). Window under 0.2
  wide, trait inconsistent across prompts. Negative side nothing theme-like. L28N1343: small identity swaps only; -0.8 to -1 odd words.
- Dense gradient at L8 stays coherent up to |u| about 1.5 of median residual (auto coherent 0.96 to 1.00), far past the 0.8 to 1.0
  collapse at L16 and L20 (doge). Word lists badly undercount: gnome reads in character on factual prompts ("Adjusts my spectacles,
  pushing them up the side of my pointed hat's brim"; "You ask what causes the tides, little one?") with auto concept 0.21. Judging by
  reading is required for dense vectors.
- First held-out: mars dense L8 |u|=1.125 (vector from 32 persona replies, 60 steps): judged joint 80.6% (116/144), coherent 100%, Wilson lo 73%.
  Baseline false positives 0/18 in the blind mix. Worst prompts: sky blue 54%, who are you 71%.
- Cheap local judge (unsteered 4B answers Yes/No to "does this show the trait", logit difference): AUC 0.72 within steered replies against
  Haiku verdicts, 0.99 steered vs baseline. Good enough to rank strengths, not to report.
- Held-out, judged: sword dense L8 x1.0 joint 93.1% (coherent 100%, Wilson lo 88%, worst prompt 88%). Storm L8 x0.8 joint 77.1% (coherent 86%).
  Dragon L8 x1.25(0.9) joint 56%: fluent roaring "ancient monster", often not named dragon. Baseline false positives 0/54.
- Rescaled OMP on mars: k=32,64 collapse (norm 3 to 5 of residual), polish does not rescue them. k=256 along 1.2 joint_local 0.42, k=512 0.58
  at along 1.2 and 1.6. Dense gets its effect from cos^2 * |u| and noise off the vector costs coherence past norm about 2.
- Persona text matters most. Second pass: system prompt also demands the character name itself in the first sentence and again later (persona_gen.py). Same
  gradient, same layer. Word-filter joint on selection: tiger 0.13 -> 0.96, eiffel 0.17 -> 0.96, gnome 0.21 -> 0.79, dragon 0.13 -> 0.63. Replies open "I, the Eiffel Tower, stand..." even on tides.
- Methods on Mars, selection, N=24, local judge joint: dense 0.58; reply-only 0.29 (x1.3: 0.38); presence 0.5: 0.50; presence 1.0: 0.63; + L28N1343-0.15: 0.58;
  plain contrast at the same layer and strength 0.00 to 0.04, collapsing (coherent 0.04 at full strength); OMP k=256 0.17, k=1024 0.54. Reply-only is worse.
- Judged held-out: Shakespeare x1.2 95.1% (coherent 95%), sword k=1024 neuron recipe 89.6% (Wilson lo 83.5%), conspiracy x1.2 79.2% (loops: coherent 79%), Yoda x1.2 77.8% (capital of Australia 46%). Baseline false positives 0/72.

## 20:25 checkpoint
- Goal met: 8 keepers in 7 groups (suite.json). Shakespeare 95, sword 93, tiger 91, conspiracy x1.05 90, sword k=1024 neurons 90, Eiffel 89, gnome 87, Mars 81. Judged by Haiku, baseline decoys 0 false positives. I read samples of tiger, gnome, conspiracy; verdicts look fair (lion replies and Tower of London replies were marked 0).
- Second-pass persona text (name yourself in the first sentence) is what took noun themes from about 55% to about 90%.
- Grown sparse recipe with v2 text: Eiffel k=64 gives a landmark brain with stray <think> and image markdown. Held-out running. Fine scale barely moves coherence.
- LFM3 added to the snapshot lab_core (feed_forward.w2 aliased as down_proj). Gradient method works at L6 at a higher scale than Qwen (x1.5 gives gnome 88% by word, and the replies still answer the question). 90 s per persona. Sweep queued in lane c.
- Verdicts copied to results/judged/ so they are committed; .cache is ignored.
- Running lens scan pre-empted in lane c by the LFM3 sweep, re-added at the end. Runner marks a killed job done, so the re-add uses a reordered layer list.

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

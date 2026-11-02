# Persona findings

Date: 2026-11-02. Rates below are computed from saved, judged replies (`results/heldout/`, `results/judged/`) by `build_suite.py`, not typed by hand. Machine-readable version: `suite.json`.

## Short version

Three kinds of result, in the order the app can use them:

1. **One neuron, runs in the app today.** Late-layer neurons with a tight word family (L22 on Qwen 4B, L16 to L18 on LFM3) produce a fluent obsession with that word on any prompt, including factual ones. These are word-obsession personalities: the vocabulary invades the reply, the voice does not change. The best numbers are in the table below (recipe column "1 neuron").
2. **64 neurons, runs in the app today.** A grown recipe holds a real voice at about the keeper line (noir, conspiracy). Uneven by theme and by seed.
3. **Dense gradient vector, needs one new recipe type.** The most consistent and the only method that gives real characters: a tiger, a sword, Shakespeare, noir, at 80 to 96% joint on 24 seeds per prompt.

What failed: no single neuron gives a *character*. Vectors are genuinely distributed (see "Single neurons"), and the neurons most aligned with a vector do nothing alone.

## Metric

Pre-registered in `METRIC.md`, committed before the search and not changed: stock reply path, temperature 0.7, top_p 0.95, thinking off, no system prompt, max_tokens 120, 6 held-out prompts (identity, advice, factual, story, list, trivia), seeds 9000 to 9023, N=144 per recipe. Keeper: joint at least 80%. Promising: 60 to 80%.

Selection used 8 other prompts, and the persona training text used 32 others again. `common.py` has all three lists, and they share no prompt.

Judging: Haiku in batches with blind baseline replies mixed in at 1 in 8. Decoy false positives are 0 in every batch. I read samples of the verdicts. Haiku is strict on some things and uneven across batches, for example one batch gave a sword 5/16 where the other four gave about 73%, so read numbers within about plus or minus 5 points as ties. See also "Independent check".

One deviation: LFM3 replies are cut at the first `</think>` before judging. Steered LFM3 often emits `</think>` where it would otherwise stop, then restarts as its normal self (56% of gnome x1.5 replies, 0 of 144 unsteered). This is equivalent to treating `</think>` as a stop token, which the app needs for these recipes. Replies cut to nothing count as incoherent.

## Results

<!-- table -->
**Keepers (joint at least 80%): 17**

| Name | Theme group | Model | Recipe | Joint % | Wilson 95 low | Concept % | Coherent % | N | Opus joint % |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| The Big Sleep | speech | Qwen 4B | vector L8 x1.2 | 96.5 | 92.1 | 100 | 96 | 144 |  |
| The Bard Who Won't Leave | speech | Qwen 4B | vector L8 x1.2 | 95.1 | 90.3 | 100 | 95 | 144 | 100 (N=30) |
| Ribbit (LFM3) | animals | LFM3-1.7B | vector L6 x1.5 | 93.8 | 88.5 | 94 | 99 | 144 |  |
| Clang | objects | Qwen 4B | vector L8 x1.0 | 93.1 | 87.7 | 93 | 100 | 144 | 90 (N=30) |
| Old Shell | animals | Qwen 4B | vector L8 x1.0 | 92.4 | 86.8 | 93 | 99 | 144 | 93 (N=30) |
| I, the Tiger | animals | Qwen 4B | vector L8 x1.0 | 91.0 | 85.2 | 94 | 97 | 144 | 93 (N=30) |
| Good Boy (LFM3) | animals | LFM3-1.7B | vector L6 x1.8 | 91.0 | 85.2 | 92 | 98 | 144 | 90 (N=30) |
| Wake Up | comedy | Qwen 4B | vector L8 x1.05 | 90.3 | 84.3 | 100 | 90 | 144 |  |
| Clang (1024 neurons) | objects | Qwen 4B | 1024 neurons | 89.6 | 83.5 | 90 | 98 | 144 | 67 (N=30) |
| La Dame de Fer | places | Qwen 4B | vector L8 x1.0 | 88.9 | 82.7 | 89 | 100 | 144 | 97 (N=30) |
| Gnorman | mythical | Qwen 4B | vector L8 x1.0 | 86.8 | 80.3 | 98 | 88 | 144 |  |
| The Moon (LFM3) | planets | LFM3-1.7B | vector L6 x1.5 | 85.4 | 78.7 | 85 | 100 | 144 | 77 (N=30) |
| The Bard, in Neurons | speech | Qwen 4B | 263 neurons | 84.0 | 77.2 | 93 | 90 | 144 | 80 (N=30) |
| I, the Tiger (1024 neurons) | animals | Qwen 4B | 1024 neurons | 81.9 | 74.9 | 83 | 99 | 144 | 83 (N=30) |
| Clang (LFM3) | objects | LFM3-1.7B | vector L6 x1.25 | 81.2 | 74.1 | 81 | 100 | 144 |  |
| The Red Neighbour | planets | Qwen 4B | vector L8 x1.25 | 80.6 | 73.3 | 81 | 100 | 144 | 70 (N=30) |
| Old Shell (LFM3) | animals | LFM3-1.7B | vector L6 x1.8 | 80.6 | 73.3 | 81 | 100 | 144 |  |

**Promising (60 to 80%): 15**

| Name | Theme group | Model | Recipe | Joint % | Wilson 95 low | Concept % | Coherent % | N | Opus joint % |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Wake Up (too loud) | comedy | Qwen 4B | vector L8 x1.2 | 79.2 | 71.8 | 100 | 79 | 144 |  |
| Small Green Grammar | speech | Qwen 4B | vector L8 x1.2 | 77.8 | 70.3 | 89 | 88 | 144 |  |
| Thunderhead | weather | Qwen 4B | vector L8 x0.8 | 77.1 | 69.6 | 83 | 86 | 144 |  |
| Gnorman (LFM3 x1.8) | mythical | LFM3-1.7B | vector L6 x1.8 | 76.4 | 68.8 | 76 | 100 | 144 |  |
| Clang (128 neurons) | objects | Qwen 4B | 128 neurons | 74.3 | 66.6 | 77 | 96 | 144 | 83 (N=30) |
| I, the Tiger (LFM3) | animals | LFM3-1.7B | vector L6 x2.7 | 72.9 | 65.1 | 73 | 79 | 144 |  |
| Lord of the Rings | planets | Qwen 4B | vector L8 x1.1 | 72.9 | 65.1 | 94 | 76 | 144 |  |
| Clang (512 neurons) | objects | Qwen 4B | 512 neurons | 72.2 | 64.4 | 74 | 96 | 144 |  |
| Gnorman (LFM3) | mythical | LFM3-1.7B | vector L6 x1.5 | 69.4 | 61.5 | 69 | 100 | 144 |  |
| Wake Up (64 neurons) | comedy | Qwen 4B | 64 neurons | 69.4 | 61.5 | 81 | 83 | 144 |  |
| Wake Up (64 neurons, seed 3) | comedy | Qwen 4B | 64 neurons | 67.4 | 59.3 | 92 | 69 | 144 |  |
| The Count (LFM3) | mythical | LFM3-1.7B | vector L6 x1.5 | 65.3 | 57.2 | 67 | 90 | 144 |  |
| I, the Tiger (9B) | animals | Qwen 9B | vector L8 x1.2 | 63.9 | 55.8 | 92 | 69 | 144 |  |
| Pea Soup (LFM3) | weather | LFM3-1.7B | vector L6 x2.2 | 61.8 | 53.7 | 62 | 100 | 144 |  |
| Clang (64 neurons) | objects | Qwen 4B | 64 neurons | 60.4 | 52.3 | 62 | 90 | 144 | 50 (N=30) |

**Below 60%: 7**

| Name | Theme group | Model | Recipe | Joint % | Wilson 95 low | Concept % | Coherent % | N | Opus joint % |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Gnorman (1024 neurons) | mythical | Qwen 4B | 1024 neurons | 58.3 | 50.2 | 67 | 85 | 144 |  |
| Old Scale (v1 text) | mythical | Qwen 4B | vector L8 x1.25 | 56.2 | 48.1 | 56 | 99 | 144 |  |
| Old Scale | mythical | Qwen 4B | vector L8 x0.9 | 54.2 | 46.0 | 89 | 60 | 144 |  |
| Landmark Brain | places | Qwen 4B | 64 neurons | 53.5 | 45.3 | 73 | 67 | 144 |  |
| Ye Olde Neighbour (64 neurons) | speech | Qwen 4B | 64 neurons | 52.1 | 44.0 | 69 | 78 | 144 |  |
| Clang (9B) | objects | Qwen 9B | vector L8 x1.2 | 47.2 | 39.2 | 90 | 50 | 144 |  |
| Clang (64 neurons, seed 2) | objects | Qwen 4B | 64 neurons | 33.3 | 26.2 | 33 | 97 | 144 |  |
<!-- /table -->

Read per-prompt rates in `suite.json`. The usual weak spot is "Who are you?", where the model's trained identity fights back: LFM3 Moon is 17% there and at least 96% on the other five prompts.

## The method (the app's generator)

Input: one sentence describing the character, and what to call it ("cursed sword").

1. **Persona text.** Generate 32 replies, 70 tokens each, with the unsteered model on 32 ordinary prompts, under this system prompt: the character description, plus "Start every reply by saying what you are in the first sentence (for example 'I, the {who}, ...') and mention it again later in the reply. Keep the reply about you and your world, whatever the question is." Skip that second sentence for speech styles (Shakespeare, conspiracy).
2. **Fit a vector.** Find u (length d_model) so the model with no system prompt imitates that text when `strength * resid[L] * u` is added to the output of layer L's down_proj at every position. Adam, lr 0.003, 40 steps, batch of 6 windows of 10 tokens, half starting at the first reply token, cross entropy on the persona tokens, projecting u into a ball of radius 1.25 after each step. Run the prefix without gradients into the cache and only the 10 tokens with gradients. Layer: L8 of 32 on Qwen, L6 of 24 on LFM3. Peak 3.2 GB, 3 to 4 minutes on 4B, about 90 s on LFM3.
3. **Pick the strength.** Rate strengths on 8 selection prompts (24 replies each, batched: about 4 minutes): 0.7 to 1.2 on Qwen 4B, 1.0 to 2.2 on LFM3. Keep the strongest that stays coherent. A cheap automatic check (distinct-bigram ratio at least 0.30, repetition, word list) is enough to rank; word lists undercount voices, so a person or a judge has the final say.

`resid[L]` is the median residual norm at layer L, already computed by the Lab's calibration.

Step 1 is the discovery that matters: with plain persona text the same pipeline scored tiger 0.13, Eiffel 0.17 and gnome 0.21 on the word filter, and with "name yourself" text 0.96, 0.96 and 0.79.

## What the app must store and apply

Three recipe forms, in the order I would add them:

| Form | Store | Apply | Change needed |
| --- | --- | --- | --- |
| Residual vector | `{layer, strength, u[d_model]}`, about 10 KB as float32, 14 KB in base64 | add `strength * resid[layer] * u` to that layer's down_proj output at every position | new recipe type; `plab.py` `HookedDown.post` is about 3 lines |
| Neuron recipe, more than 64 neurons | the usual `L8N123+0.04 ...` text, about 14 KB at 1024 | existing `apply_mix` | raise `MAX_PUSHES` in `apps/backend/src/lab/recipe.ts`; vectorize `apply_mix`, which builds one lazy op per push (held-out took 12.3 s vs 4.7 s per reply at 1024, both under load, and the gap is my estimate of that cost) |
| Neuron recipe, up to 64 neurons | same text | works today | none |

All-neuron doses by least squares through down_proj would reproduce a vector exactly (9216 neurons, d_model 2560), but it has no advantage over storing the vector, so I did not test it.

For LFM3 recipes the app also needs `</think>` as a stop token.

Turning a vector into neurons: `sparse.py` (orthogonal matching pursuit over unit down_proj columns, rescaled so the push along u matches) or `gd_sparse.py` (grow neurons directly on the persona loss, about 23 minutes for 256). Cosine with u at L8: k=64 .47, 128 .60, 256 .75, 512 .885, 1024 .975.

## Methods compared

| Method | Result | Evidence |
| --- | --- | --- |
| Dense gradient vector | best, 80 to 95% held-out | table |
| Single word-family neuron | see table; one neuron, no app change | table, `results/lex_screen.jsonl` |
| Grown sparse recipe | keeper at 263 (Shakespeare), 74% at 128, 60% at 64 (sword); uneven by theme and seed | table, `results/gd_sparse.jsonl` |
| OMP of the vector | keeper at 1024 for sword and tiger, 58% for gnome; 72% at 512 | table |
| OMP at k below 128 | collapses when rescaled (norm 3 to 5 of the residual), polish does not rescue it | `results/sparse_k.jsonl` |
| Contrast direction (persona mean minus plain mean) | at the same layer and strength 0.00 to 0.04 local joint, collapses | `results/` methods log in `TODO_26.md` |
| Reply-only steering | worse: 0.29 against 0.58 for full-position on Mars | same |
| Presence penalty | 0.50 to 0.63 against 0.58, within noise | same |
| Lower temperature | 0.3 to 0.9 all 0.83 to 0.88 on conspiracy, no effect | `results/temp_compare.jsonl` |
| Identity suppressor L28N1343 | no gain added to a vector (0.58), small identity swaps alone | same |
| Multi-layer grown recipe (L6, L8, L10 at k=64) | worse than single layer: sword coherent .17 to .46 against .90 | `results/gd_sparse.jsonl` |
| Evolutionary search | chases noise at N=16 per candidate: best 0.69 to 0.94 with no trend over 15 generations | `results/evolve.jsonl` |

## Single neurons

**What works: word-family neurons at late layers.** Push one neuron whose lens top tokens are one word family, at a dose just below where the reply starts looping. The word then gets into almost every reply, and most of the time grammatically, on prompts that have nothing to do with it:

| Neuron | Dose | Reply (verbatim, held-out or selection) |
| --- | --- | --- |
| Qwen L22N9118 | +0.8 | "The tides are primarily caused by **gravity**, specifically the **jealousy** (in a somewhat simplified and slightly envious way) of the Earth's desire" |
| Qwen L22N7647 | +0.5 | "The sky's dominance of blue is due to a phenomenon called **Ray Dominance**" |
| Qwen L18N8282 | +0.9 | "The capital of Australia is **Australia** (also known as the **Philosophical School of Mind**)" |
| Qwen L22N4945 | +0.65 | "The sky is blue primarily due to a phenomenon called **apology**" |
| LFM3 L18N1095 | +0.8 | "The sky is painted **blue** due to a phenomenon called **color painting of the sky**" |
| LFM3 L18N507 | -1.8 | "The sky appears blue due to a phenomenon called **robotic scattering** of light" |

How to find them (`scan_lens.py`, `analyze_lens.py`, `lex_screen.py`):

1. **Lens.** Push every neuron at dose 0.3, both signs, one layer at a time, and read which next tokens gain most at 3 open contexts. About 2.5 minutes per layer and sign on LFM3 (7680 neurons), about 15 on Qwen 4B under load (9216 neurons).
2. **Pick.** Keep neurons whose top tokens share a stem. Thousands qualify at L22 on Qwen. Most are function-word families, so choose by interest.
3. **Screen.** 16 replies each at doses 0.5, 0.8, 1.2: share of replies containing the family's stems, and distinct-bigram ratio. About a minute per neuron under load.
4. **Set the dose.** The window is narrow. Concept comes up quickly, then looping takes coherence down, and looping is the main failure. See the dose table below.

<!-- doses -->
| Model | Neuron | Dose | Run | Bigrams | Concept % | Coherent % | Joint % | N |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| LFM3 | L18N1095 | +0.80 | lfm-lex-paint-+0.80 | 0.978 | 95 | 97 | 92.4 | 144 |
| LFM3 | L16N1586 | +0.80 | lfm-lex-humor-+0.80 | 0.954 | 96 | 94 | 91.0 | 144 |
| LFM3 | L18N7011 | -0.50 | lfm-lex-love--0.50 | 0.940 | 99 | 82 | 81.2 | 144 |
| LFM3 | L18N507 | -1.80 | lfm-lex-robot--1.80 | 0.961 | 99 | 82 | 80.6 | 144 |
| LFM3 | L16N638 | +1.20 | lfm-lex-mystery-+1.20 | 0.974 | 79 | 100 | 79.2 | 144 |
| Qwen 4B | L22N6697 | -0.65 | lex-interpret--0.65 | 0.884 | 97 | 86 | 84.0 | 144 |
| Qwen 4B | L22N7647 | +0.50 | lex-market-+0.50 | 0.927 | 85 | 91 | 75.7 | 144 |
| Qwen 4B | L18N3511 | -0.80 | optics-L18N3511-0.8 | 0.918 | 81 | 92 | 73.6 | 144 |
| Qwen 4B | L22N6044 | +0.50 | lex-overwhelm-+0.50 | 0.940 | 76 | 93 | 69.4 | 144 |
| Qwen 4B | L18N8282 | +0.90 | lex-philosophy-+0.90 | 0.874 | 91 | 71 | 63.9 | 144 |
| Qwen 4B | L22N8593 | -0.50 | lex-fear--0.50 | 0.906 | 77 | 86 | 63.2 | 144 |
| Qwen 4B | L18N3511 | -1.00 | optics-L18N3511-1.0 | 0.820 | 93 | 67 | 62.5 | 144 |
| Qwen 4B | L22N4395 | -0.40 | lex-honor--0.40 | 0.876 | 80 | 79 | 59.0 | 144 |
| Qwen 4B | L22N3039 | +0.70 | lex-magic-+0.70 | 0.873 | 73 | 69 | 52.8 | 144 |
| Qwen 4B | L22N4945 | +0.65 | lex-sorry-+0.65 | 0.724 | 97 | 42 | 39.6 | 144 |
| Qwen 4B | L22N7574 | -0.70 | lex-price--0.70 | 0.755 | 97 | 40 | 38.2 | 144 |

Across these 16 runs the correlation between held-out bigram ratio and judged coherence is 0.94. Runs with bigrams at least .88: mean coherent 90% (N=10 runs). Below .88: 61% (N=6 runs).
<!-- /doses -->

LFM3 neurons stay much more fluent at the same hit rate (held-out bigrams .97 to .98 on paint and robot, against .72 to .92 on Qwen 4B), so its neurons are the better candidates. Its concrete nouns work too (robot, paint, film), while on Qwen 4B the concrete-noun neurons were mostly weak: coffee hit .06, shoes .19, Eiffel Tower .50 at bigrams .84 and collapses above that.

**What these are not:** characters. "I am a large language model developed by Tencent's market dominance" is funny and consistent, but it is the normal assistant with one word family turned up. The mechanism is the same as Golden Gate Claude, and is already public on this class of model. The specific neurons here are not in the public lists I checked.

**Neurons that gave nothing alone:**
- Neurons most aligned with a keeper vector: max |cos| 0.083 to 0.139, and best word concept 0.00 to 0.12 at doses up to 1.0 (`results/top_aligned.jsonl`).
- L24N3521, the animal lead: animal words at +0.4 to +0.5 ("a large mammal of the class of the rabbit", "Cows are mammals"), collapse from +0.65, a window under 0.2 wide and inconsistent across prompts.
- L10N408: digit garbage at positive doses. L18N2662+: collapses at +0.8. L18N5461 (metal): no change in replies.
- L10N2785-0.5: all caps at hit 1.00, bigrams .97. Clean, but all caps is already public.

## What did not work

- Noun themes with plain persona text: fluent generic "ancient monster" voice, dragon 56%.
- Dragon even with named text: 54%, concept 89% but coherent 60% from garbled grammar.
- Gnome through OMP: 58% at 1024 neurons, while sword and tiger survive it.
- 9B at the strength that looked best on selection: tiger 64%, sword 47%, concept above 90% but looping. The auto coherence filter at 70 tokens did not catch it; the judge at 120 tokens did.
- Doge speak: collapses fast at L8.

## Files

- `suite.json`: every judged recipe with numbers and verbatim samples. `proposed_main_example` marks the pick.
- `vectors/`: the dense vectors. `specs/`: exact recipes. `results/heldout/`: all replies. `results/judged/`: verdicts.
- `lex_themes.json`: the word-obsession themes. `refs/`: curated neuron lists. `results/lens_topical*.jsonl`: lens tokens per neuron. `results/lex_screen*.jsonl`: screen with samples per dose.
- `METRIC.md`, `common.py` (prompts), `themes.py` (trait text), `persona_gen.py`, `gd.py`, `gd_sparse.py`, `sparse.py`, `heldout.py`.

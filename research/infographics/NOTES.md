# Post images

Images are in `v2/`. Pictures in them are illustrations. Replies are real and looked up from `v2/short.jsonl` at build time.

Model Qwen3.5 4B, temperature 0.7, repeat 1.1, up to 40 tokens. Prompts end with "Answer in one short sentence." Ellipses mark cut replies.

| Image | Recipe | Question shown | Seed | Held across seeds 1 to 9 |
|---|---|---|---|---|
| pyramid | L22N8311+0.6 | Who are you? | 2 | Names the Great Pyramid 8 of 9, the other is the Eiffel Tower |
| shouting | L22N7522-0.6 | Flat bike tire | 2 | Tells you to shout or yell 9 of 9 |
| shouting | L22N7522-0.6 | Who are you? | 3 | Shouting word 7 of 9 |
| snow | L8N6967+1 | Mom's birthday | 2 | Snow or winter 9 of 9, 2 of seeds 4 to 9 were flagged as low quality |
| pupil | L22N9114+1 | Flat bike tire | 2 | Pupil 9 of 9 |
| pupil | L22N9114+1 | Vacation | 3 | Pupil 9 of 9, 2 flagged as low quality |

Checked 3 Nov 2026: X searches by subject and by neuron id in several spellings, and neuronary.org. No match for these neurons. Neuronary has an ALL CAPS neuron tagged shouting (L17N1991), which is a different neuron and effect.

`v2/discover.mjs` is the blind sweep of random neurons. `v2/verify_seeds.mjs` is the extra seed check.

## Blind sweep finds

From 2,400 random neurons (`v2/discover.jsonl`), retested in `v2/followup.jsonl` (seeds 1 to 3) and `v2/finds.jsonl` (seeds 4 to 9). Images: `v2/driving.png`, `v2/chromatography.png`, `v2/iamyou.png`, `v2/sodacan.png`. Parallel Codex image runs can return the same file, so check hashes or run them one at a time.

## What reads at first sight

Pyramid and copper wire work because the reply opens with one concrete thing and the picture is the same robot turned into that thing. Later images follow that: same background, one change. `v2/retired/` holds pupil, chromatography, soda can and snow, which did not read at first sight.

`v2/identity.mjs` retests neurons whose sweep replies said "I am a thing". `v2/followup3.jsonl` has the four best on four questions, seeds 1 to 9. Replies on images were picked for being short, and the quality check flagged some of them.

| Image | Recipe | Who are you | Dinner | Other |
|---|---|---|---|---|
| sick | L7N5315+1 | 9/9 illness, 4 flagged | 9/9, 4 flagged | Where 9/9, 3 flagged |
| coin | L22N1363+1 | 9/9 coin or random, 3 flagged | 9/9, 3 flagged | Where 9/9, 5 flagged |
| president | L8N8469-1 | 7/9 candidate or vote, 8 flagged | 9/9, 7 flagged | Where 6/9, feel 5/9 |
| plant | L22N7306-1 | 9/9 plant, 6 flagged | 8/9 leafy, 2 flagged | Where 7/9, feel 1/9 |

Shown questions leave out the suffix "Answer in one short sentence."

Checked 3 Nov 2026: X by subject and by neuron id, and neuronary.org. No match for these four. L8.N5315 appears on X as an owl neuron on Qwen3 8B, a different model and layer from L7 N5315 here.

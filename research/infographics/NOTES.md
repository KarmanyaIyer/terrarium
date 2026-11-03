# Post images

Images are in `v2/`: `pyramid.png`, `shouting.png`, `snow.png`, `pupil.png`. Pictures in them are illustrations. Replies are real and looked up from `v2/short.jsonl` at build time.

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

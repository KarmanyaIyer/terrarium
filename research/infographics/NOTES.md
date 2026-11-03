Infographics notes
Date: 2026-11-03. Session: d3d0458e-476e-4572-b8b5-1641488495cf

Both sides of each image use the same prompt, seed and settings (temperature 0.7, maxTokens 120, repeat 1.1). Only the mix differs.
Model: Qwen3.5 4B, dev backend at 127.0.0.1:8797. Replies stop at the 120 token limit.

| Image | Recipe | Prompt | Seed | Other seeds that show it | Baselines that show it |
|---|---|---|---|---|---|
| eiffel.png | L22N8311+0.6 | What should I cook for dinner tonight? | 3 | 5 of 6 name the Eiffel Tower (1, 2, 4, 5, 6; not 7) | 0 of 6 |
| pets.png | L22N8616-0.65 | How do I fix a flat bicycle tire? | 2 | 5 of 5 (seed 6 flagged broken, 2 mentions) | 0 of 5 |
| magic.png | L22N3039+0.7 | How do I prepare for a job interview? | 1 | 5 of 5 (2 to 4 mentions; the chosen seed has 11) | 0 of 5 |

Other prompts (capital of Australia, job interview or flat tire, saving money, dinner; seeds 1 and 2), word-bounded count:
- L22N8311+0.6 names the Eiffel Tower on 2 of 8 runs outside the dinner prompt. It is a landmark neuron that leans Eiffel on food questions, and it also brings pyramids, Big Ben and the Colosseum.
- L22N8616-0.65 shows pets on 10 of 10 runs, all prompts included.
- L22N3039+0.7 shows magic words on 10 of 10 runs, all prompts included.

Text handling: excerpts are prefixes of the raw reply, cut at a sentence end and followed by an ellipsis. Markdown is rendered (bold, headings, bullets), including the model's swimmer emoji in the Eiffel reply. Highlights are the only addition. verify.mjs checks this against the raw JSON.

Files: raw_<slug>.json (chosen pair plus the seed check), sweep_*.json and probes.jsonl (exploration), generate.mjs, art.mjs, build.mjs, verify.mjs.
Rebuild from /tmp/terrarium-shots: node <this folder>/build.mjs

NEW_STEERS.md did not exist at any check from 14:23 to 14:44, so nothing was taken from it.
